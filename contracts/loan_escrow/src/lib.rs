#![no_std]
//! loan_escrow: a loan's money on Stellar, from the lender to the borrower and back.
//!
//! Lifecycle: `Created -> Funded -> Active -> Repaid -> Closed`, or `Created -> Cancelled`.
//! `open_funded` does create + fund + disburse in one call (one transaction for the demo).
//!
//! - One token per contract (the NGNT Stellar Asset Contract on testnet), fixed at construction.
//!   Every loan in this escrow is in that token, so a loan can never be funded in one asset and
//!   repaid in another, and no call has to pass (or be checked for) a token address. Another
//!   asset means another deployment of this contract.
//! - The contract holds money only between `fund` and `disburse` (one loan's principal). It
//!   never holds everyday user balances; repayments go straight from the payer to the lender.
//! - No personal data: only addresses, amounts, timestamps and the 32-byte loan id (a reference
//!   made off-chain, never a name or number).
//! - Amounts are `i128` in the token's units (7 decimals). Every state change publishes an event.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    Env, Symbol, Vec,
};
use stellar_access::access_control::{self, AccessControl};

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 120 * DAY_IN_LEDGERS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum LoanState {
    /// Terms agreed by the admin, the lender and the borrower; no money has moved.
    Created = 0,
    /// The principal is held by this contract.
    Funded = 1,
    /// The principal is with the borrower; repayments are open.
    Active = 2,
    /// Repayments reached `total_due`.
    Repaid = 3,
    /// Called off before any money moved. Final.
    Cancelled = 4,
    /// A repaid loan, closed by the admin. Final.
    Closed = 5,
}

/// One loan.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Loan {
    pub lender: Address,
    pub borrower: Address,
    pub principal: i128,
    pub total_due: i128,
    pub repaid: i128,
    /// Unix seconds. Repayments are still accepted after it (late is not refused).
    pub due_ts: u64,
    pub state: LoanState,
    pub created_at: u64,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub token: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Token,
    Loan(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
    InvalidAmount = 2,
    InvalidDueDate = 3,
    LoanExists = 4,
    LoanNotFound = 5,
    WrongState = 6,
    Overpay = 7,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
pub struct LoanCreated {
    #[topic]
    pub loan_id: BytesN<32>,
    pub lender: Address,
    pub borrower: Address,
    pub principal: i128,
    pub total_due: i128,
    pub due_ts: u64,
}

/// The principal moved lender -> contract.
#[contractevent]
pub struct LoanFunded {
    #[topic]
    pub loan_id: BytesN<32>,
    pub lender: Address,
    pub amount: i128,
}

/// The principal moved contract -> borrower.
#[contractevent]
pub struct LoanDisbursed {
    #[topic]
    pub loan_id: BytesN<32>,
    pub borrower: Address,
    pub amount: i128,
}

/// A repayment moved payer -> lender. `repaid` is the running total.
#[contractevent]
pub struct LoanRepayment {
    #[topic]
    pub loan_id: BytesN<32>,
    pub from: Address,
    pub amount: i128,
    pub repaid: i128,
    pub total_due: i128,
}

#[contractevent]
pub struct LoanRepaid {
    #[topic]
    pub loan_id: BytesN<32>,
    pub total_due: i128,
}

#[contractevent]
pub struct LoanCancelled {
    #[topic]
    pub loan_id: BytesN<32>,
    pub by: Address,
}

#[contractevent]
pub struct LoanClosed {
    #[topic]
    pub loan_id: BytesN<32>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn token(env: &Env) -> token::Client<'_> {
    // Always set by the constructor.
    let addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
    token::Client::new(env, &addr)
}

fn load(env: &Env, loan_id: &BytesN<32>) -> Result<Loan, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Loan(loan_id.clone()))
        .ok_or(Error::LoanNotFound)
}

fn save(env: &Env, loan_id: &BytesN<32>, loan: &Loan) {
    let key = DataKey::Loan(loan_id.clone());
    let store = env.storage().persistent();
    store.set(&key, loan);
    store.extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    bump_instance(env);
}

fn expect(loan: &Loan, state: LoanState) -> Result<(), Error> {
    if loan.state != state {
        return Err(Error::WrongState);
    }
    Ok(())
}

/// Checks and records a new loan (state Created). The caller has already required the auths.
fn create(
    env: &Env,
    loan_id: &BytesN<32>,
    lender: &Address,
    borrower: &Address,
    principal: i128,
    total_due: i128,
    due_ts: u64,
) -> Result<Loan, Error> {
    if principal <= 0 || total_due < principal {
        return Err(Error::InvalidAmount);
    }
    let now = env.ledger().timestamp();
    if due_ts <= now {
        return Err(Error::InvalidDueDate);
    }
    if env
        .storage()
        .persistent()
        .has(&DataKey::Loan(loan_id.clone()))
    {
        return Err(Error::LoanExists);
    }
    let loan = Loan {
        lender: lender.clone(),
        borrower: borrower.clone(),
        principal,
        total_due,
        repaid: 0,
        due_ts,
        state: LoanState::Created,
        created_at: now,
        updated_at: now,
    };
    save(env, loan_id, &loan);
    LoanCreated {
        loan_id: loan_id.clone(),
        lender: lender.clone(),
        borrower: borrower.clone(),
        principal,
        total_due,
        due_ts,
    }
    .publish(env);
    Ok(loan)
}

/// Created -> Funded: the principal moves lender -> contract. Needs the lender's auth (the
/// token transfer requires it too, covered by the same signature).
fn do_fund(env: &Env, loan_id: &BytesN<32>, loan: &mut Loan) -> Result<(), Error> {
    expect(loan, LoanState::Created)?;
    token(env).transfer(
        &loan.lender,
        env.current_contract_address(),
        &loan.principal,
    );
    loan.state = LoanState::Funded;
    loan.updated_at = env.ledger().timestamp();
    save(env, loan_id, loan);
    LoanFunded {
        loan_id: loan_id.clone(),
        lender: loan.lender.clone(),
        amount: loan.principal,
    }
    .publish(env);
    Ok(())
}

/// Funded -> Active: the principal moves contract -> borrower.
fn do_disburse(env: &Env, loan_id: &BytesN<32>, loan: &mut Loan) -> Result<(), Error> {
    expect(loan, LoanState::Funded)?;
    token(env).transfer(
        &env.current_contract_address(),
        &loan.borrower,
        &loan.principal,
    );
    loan.state = LoanState::Active;
    loan.updated_at = env.ledger().timestamp();
    save(env, loan_id, loan);
    LoanDisbursed {
        loan_id: loan_id.clone(),
        borrower: loan.borrower.clone(),
        amount: loan.principal,
    }
    .publish(env);
    Ok(())
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct LoanEscrow;

#[contractimpl]
impl LoanEscrow {
    /// `token`: the Stellar Asset Contract every loan here is paid in (NGNT on testnet).
    pub fn __constructor(env: Env, admin: Address, token: Address) {
        access_control::set_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        bump_instance(&env);
    }

    // ----- admin -----------------------------------------------------------

    /// Upgrade the code in place (admin only); the loans, the money and the contract ID stay.
    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        access_control::enforce_admin_auth(&env);
        env.deployer()
            .update_current_contract(soroban_sdk::ContractExecutable::Wasm(wasm_hash));
        Ok(())
    }

    // ----- loans -----------------------------------------------------------

    /// Record the terms. All three sign: Plus (admin) because it arranged the loan, the lender
    /// and the borrower because they agree to these exact amounts and date. No money moves.
    pub fn create_loan(
        env: Env,
        loan_id: BytesN<32>,
        lender: Address,
        borrower: Address,
        principal: i128,
        total_due: i128,
        due_ts: u64,
    ) -> Result<(), Error> {
        access_control::enforce_admin_auth(&env);
        lender.require_auth();
        borrower.require_auth();
        create(
            &env, &loan_id, &lender, &borrower, principal, total_due, due_ts,
        )?;
        Ok(())
    }

    /// Created -> Funded. The lender signs; the principal moves lender -> contract.
    pub fn fund(env: Env, loan_id: BytesN<32>) -> Result<(), Error> {
        let mut loan = load(&env, &loan_id)?;
        loan.lender.require_auth();
        do_fund(&env, &loan_id, &mut loan)
    }

    /// Funded -> Active. The principal moves contract -> borrower.
    ///
    /// Admin auth, not the borrower's: the borrower already signed the terms in `create_loan`,
    /// and receiving money needs no signature from her. The release is Plus's last check (the
    /// loan still stands, nothing was flagged between funding and payout), and in Plus the
    /// borrower's account is often one Plus operates for her (Indian users never hold crypto),
    /// so a second borrower signature would add nothing but a round trip.
    pub fn disburse(env: Env, loan_id: BytesN<32>) -> Result<(), Error> {
        access_control::enforce_admin_auth(&env);
        let mut loan = load(&env, &loan_id)?;
        do_disburse(&env, &loan_id, &mut loan)
    }

    /// create_loan + fund + disburse in one call, so the demo's "Yes" is one transaction.
    /// Same signers as `create_loan`; the lender's signature also covers the token transfer
    /// lender -> contract. Ends Active.
    pub fn open_funded(
        env: Env,
        loan_id: BytesN<32>,
        lender: Address,
        borrower: Address,
        principal: i128,
        total_due: i128,
        due_ts: u64,
    ) -> Result<(), Error> {
        access_control::enforce_admin_auth(&env);
        lender.require_auth();
        borrower.require_auth();
        let mut loan = create(
            &env, &loan_id, &lender, &borrower, principal, total_due, due_ts,
        )?;
        do_fund(&env, &loan_id, &mut loan)?;
        do_disburse(&env, &loan_id, &mut loan)
    }

    /// A repayment, partial or full, from `from` (normally the borrower; anyone may pay for
    /// her) straight to the lender. Only an Active loan, and never more than is outstanding.
    /// Reaching `total_due` makes it Repaid.
    pub fn repay(env: Env, loan_id: BytesN<32>, from: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut loan = load(&env, &loan_id)?;
        expect(&loan, LoanState::Active)?;
        // repaid <= total_due always, so this cannot overflow.
        let outstanding = loan.total_due - loan.repaid;
        if amount > outstanding {
            return Err(Error::Overpay);
        }
        token(&env).transfer(&from, &loan.lender, &amount);
        loan.repaid += amount;
        loan.updated_at = env.ledger().timestamp();
        if loan.repaid == loan.total_due {
            loan.state = LoanState::Repaid;
        }
        save(&env, &loan_id, &loan);
        LoanRepayment {
            loan_id: loan_id.clone(),
            from,
            amount,
            repaid: loan.repaid,
            total_due: loan.total_due,
        }
        .publish(&env);
        if loan.state == LoanState::Repaid {
            LoanRepaid {
                loan_id,
                total_due: loan.total_due,
            }
            .publish(&env);
        }
        Ok(())
    }

    /// Created -> Cancelled, before any money moved. `caller` is the admin or the loan's
    /// lender, and signs.
    pub fn cancel_unfunded(env: Env, loan_id: BytesN<32>, caller: Address) -> Result<(), Error> {
        let mut loan = load(&env, &loan_id)?;
        let ok = caller == loan.lender || access_control::get_admin(&env).as_ref() == Some(&caller);
        if !ok {
            return Err(Error::NotAuthorized);
        }
        caller.require_auth();
        expect(&loan, LoanState::Created)?;
        loan.state = LoanState::Cancelled;
        loan.updated_at = env.ledger().timestamp();
        save(&env, &loan_id, &loan);
        LoanCancelled {
            loan_id,
            by: caller,
        }
        .publish(&env);
        Ok(())
    }

    /// Repaid -> Closed (admin only).
    pub fn close_loan(env: Env, loan_id: BytesN<32>) -> Result<(), Error> {
        access_control::enforce_admin_auth(&env);
        let mut loan = load(&env, &loan_id)?;
        expect(&loan, LoanState::Repaid)?;
        loan.state = LoanState::Closed;
        loan.updated_at = env.ledger().timestamp();
        save(&env, &loan_id, &loan);
        LoanClosed { loan_id }.publish(&env);
        Ok(())
    }

    // ----- reads (public) --------------------------------------------------

    pub fn config(env: Env) -> Config {
        Config {
            admin: access_control::get_admin(&env).unwrap(),
            token: token(&env).address,
        }
    }

    pub fn loan(env: Env, loan_id: BytesN<32>) -> Result<Loan, Error> {
        load(&env, &loan_id)
    }
}

/// OpenZeppelin access control: admin transfer and role views.
#[contractimpl(contracttrait)]
impl AccessControl for LoanEscrow {}

mod test;
