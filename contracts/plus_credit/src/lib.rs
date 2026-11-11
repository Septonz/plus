#![no_std]
//! plus_credit: the public record of Plus loans, the assets behind them and the vouches of an
//! ajo. Lenders read it directly from Stellar (the /verify page) without trusting Plus.
//!
//! - Only the partner (or the admin) writes, and every write requires that account's auth.
//!   Reads are public.
//! - No personal data: borrowers, vouchers, loans and assets appear only as 32-byte references
//!   (HMAC-SHA256 with a key that never leaves Plus), and an asset's verification is a hash.
//!   Never names, photos, locations, phone numbers or ID numbers.
//! - It holds no money: the loan itself moves as NGNT payments; this is the agreement and its
//!   history. Amounts are `i128` with 7 decimals.
//! - Every change publishes an event.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    Symbol, Vec,
};
use stellar_access::access_control::{self, AccessControl};

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 120 * DAY_IN_LEDGERS;

const BPS_DENOMINATOR: u32 = 10_000;
/// Collateral is at most 300% of the principal (the loans table allows the same).
const MAX_COLLATERAL_PCT: u32 = 300;
/// Vouches waiting for one borrower's next loan.
const MAX_VOUCHES: u32 = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum LoanStatus {
    Active = 0,
    Late = 1,
    Restructured = 2,
    /// Reached only by repayments adding up to the total.
    Repaid = 3,
    Default = 4,
    /// Closed by the partner without being repaid by her (on testnet: the demo reset). Not counted
    /// as repaid and not as a default.
    Cancelled = 5,
}

impl LoanStatus {
    fn is_open(self) -> bool {
        matches!(
            self,
            LoanStatus::Active | LoanStatus::Late | LoanStatus::Restructured
        )
    }
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AssetLevel {
    Registered = 0,
    EvidenceVerified = 1,
    CommunityVerified = 2,
    IndependentlyVerified = 3,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AssetStatus {
    Active = 0,
    UnderReview = 1,
    Lost = 2,
    Stolen = 3,
    Damaged = 4,
    /// No longer hers or no longer offered: final.
    Released = 5,
}

/// One loan agreement.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Loan {
    pub borrower: BytesN<32>,
    pub lender: Address,
    pub principal: i128,
    pub cost: i128,
    pub total: i128,
    pub repaid: i128,
    /// Share of each money-in that repays it, in basis points (1,000 = 10%).
    pub repay_bps: u32,
    /// The minimum due each period.
    pub minimum: i128,
    pub collateral: Option<BytesN<32>>,
    /// Collateral asked for, as a percentage of the principal (150 = 150%).
    pub collateral_pct: u32,
    /// Ajo members who vouched for this loan (their references).
    pub vouchers: Vec<BytesN<32>>,
    pub status: LoanStatus,
    pub opened_at: u64,
    pub updated_at: u64,
}

/// One asset: what lenders may know about it, nothing more.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Asset {
    pub owner: BytesN<32>,
    /// A hash over the evidence held privately by Plus (photo hash, witnesses, inspection).
    pub verification: BytesN<32>,
    pub level: AssetLevel,
    pub status: AssetStatus,
    /// The loan it currently secures, if any.
    pub pledged_to: Option<BytesN<32>>,
    pub registered_at: u64,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub partner: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Partner,
    Loan(BytesN<32>),
    LoansOf(BytesN<32>),
    Asset(BytesN<32>),
    AssetsOf(BytesN<32>),
    Vouches(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
    InvalidAmount = 2,
    LoanExists = 3,
    LoanNotFound = 4,
    LoanClosed = 5,
    Overpayment = 6,
    InvalidTransition = 7,
    AssetExists = 8,
    AssetNotFound = 9,
    LevelDown = 10,
    CollateralUnavailable = 11,
    AssetPledged = 12,
    SelfVouch = 13,
    AlreadyVouched = 14,
    TooManyVouches = 15,
    VouchNotFound = 16,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
pub struct PartnerSet {
    pub partner: Address,
}

#[contractevent]
pub struct LoanOpened {
    #[topic]
    pub loan: BytesN<32>,
    #[topic]
    pub borrower: BytesN<32>,
    pub lender: Address,
    pub principal: i128,
    pub cost: i128,
    pub total: i128,
    pub repay_bps: u32,
    pub minimum: i128,
    pub collateral: Option<BytesN<32>>,
    pub collateral_pct: u32,
    pub vouchers: u32,
}

#[contractevent]
pub struct LoanRepayment {
    #[topic]
    pub loan: BytesN<32>,
    pub amount: i128,
    pub repaid: i128,
    pub total: i128,
    pub payment_ref: BytesN<32>,
}

#[contractevent]
pub struct LoanStatusChanged {
    #[topic]
    pub loan: BytesN<32>,
    pub from: LoanStatus,
    pub to: LoanStatus,
}

#[contractevent]
pub struct AssetRegistered {
    #[topic]
    pub asset: BytesN<32>,
    #[topic]
    pub owner: BytesN<32>,
    pub level: AssetLevel,
    pub verification: BytesN<32>,
}

#[contractevent]
pub struct AssetLevelChanged {
    #[topic]
    pub asset: BytesN<32>,
    pub from: AssetLevel,
    pub to: AssetLevel,
    pub verification: BytesN<32>,
}

#[contractevent]
pub struct AssetStatusChanged {
    #[topic]
    pub asset: BytesN<32>,
    pub from: AssetStatus,
    pub to: AssetStatus,
}

#[contractevent]
pub struct AssetCollateral {
    #[topic]
    pub asset: BytesN<32>,
    /// The loan it now secures, or None when released.
    pub loan: Option<BytesN<32>>,
}

#[contractevent]
pub struct Vouched {
    #[topic]
    pub borrower: BytesN<32>,
    #[topic]
    pub voucher: BytesN<32>,
}

#[contractevent]
pub struct VouchRevoked {
    #[topic]
    pub borrower: BytesN<32>,
    #[topic]
    pub voucher: BytesN<32>,
}

/// A loan someone vouched for defaulted: their vouching rights pause (off-chain, 6 months).
/// Nothing is taken from them.
#[contractevent]
pub struct VouchedLoanDefaulted {
    #[topic]
    pub voucher: BytesN<32>,
    #[topic]
    pub loan: BytesN<32>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn put<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, val: &V) {
    let store = env.storage().persistent();
    store.set(key, val);
    store.extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey) -> Option<V> {
    env.storage().persistent().get(key)
}

fn partner(env: &Env) -> Address {
    // Always set by the constructor.
    env.storage().instance().get(&DataKey::Partner).unwrap()
}

/// Every write starts here: the caller is the partner or the admin, and signed.
fn writer(env: &Env, caller: &Address) -> Result<(), Error> {
    let ok = *caller == partner(env) || access_control::get_admin(env).as_ref() == Some(caller);
    if !ok {
        return Err(Error::NotAuthorized);
    }
    caller.require_auth();
    bump_instance(env);
    Ok(())
}

fn load_loan(env: &Env, loan: &BytesN<32>) -> Result<Loan, Error> {
    get(env, &DataKey::Loan(loan.clone())).ok_or(Error::LoanNotFound)
}

fn load_asset(env: &Env, asset: &BytesN<32>) -> Result<Asset, Error> {
    get(env, &DataKey::Asset(asset.clone())).ok_or(Error::AssetNotFound)
}

fn list(env: &Env, key: &DataKey) -> Vec<BytesN<32>> {
    get(env, key).unwrap_or_else(|| Vec::new(env))
}

fn push(env: &Env, key: &DataKey, item: &BytesN<32>) {
    let mut v = list(env, key);
    v.push_back(item.clone());
    put(env, key, &v);
}

/// Statuses a loan may move to by `loan_set_status`. Repaid comes only from repayments;
/// Repaid, Default and Cancelled are final.
fn may_move(from: LoanStatus, to: LoanStatus) -> bool {
    from.is_open() && to != LoanStatus::Repaid
}

/// When a loan closes, its collateral is free again, unless it defaulted (then it stays pledged
/// for the lender).
fn release_collateral(env: &Env, loan_ref: &BytesN<32>, loan: &Loan) {
    if let Some(a) = &loan.collateral {
        if let Some(mut asset) = get::<Asset>(env, &DataKey::Asset(a.clone())) {
            if asset.pledged_to.as_ref() == Some(loan_ref) {
                asset.pledged_to = None;
                asset.updated_at = env.ledger().timestamp();
                put(env, &DataKey::Asset(a.clone()), &asset);
                AssetCollateral {
                    asset: a.clone(),
                    loan: None,
                }
                .publish(env);
            }
        }
    }
}

fn set_loan_status(env: &Env, loan_ref: &BytesN<32>, loan: &mut Loan, to: LoanStatus) {
    let from = loan.status;
    loan.status = to;
    loan.updated_at = env.ledger().timestamp();
    put(env, &DataKey::Loan(loan_ref.clone()), loan);
    LoanStatusChanged {
        loan: loan_ref.clone(),
        from,
        to,
    }
    .publish(env);
    match to {
        LoanStatus::Repaid | LoanStatus::Cancelled => release_collateral(env, loan_ref, loan),
        LoanStatus::Default => {
            for v in loan.vouchers.iter() {
                VouchedLoanDefaulted {
                    voucher: v,
                    loan: loan_ref.clone(),
                }
                .publish(env);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct PlusCredit;

#[contractimpl]
impl PlusCredit {
    pub fn __constructor(env: Env, admin: Address, partner: Address) {
        access_control::set_admin(&env, &admin);
        env.storage().instance().set(&DataKey::Partner, &partner);
        bump_instance(&env);
        PartnerSet { partner }.publish(&env);
    }

    // ----- admin -----------------------------------------------------------

    /// Rotate the partner account (admin only).
    pub fn set_partner(env: Env, partner: Address) -> Result<(), Error> {
        access_control::enforce_admin_auth(&env);
        env.storage().instance().set(&DataKey::Partner, &partner);
        bump_instance(&env);
        PartnerSet { partner }.publish(&env);
        Ok(())
    }

    /// Upgrade the code in place (admin only); the records and the contract ID stay.
    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        access_control::enforce_admin_auth(&env);
        env.deployer()
            .update_current_contract(soroban_sdk::ContractExecutable::Wasm(wasm_hash));
        Ok(())
    }

    // ----- loans -----------------------------------------------------------

    /// A new loan agreement. The borrower's waiting vouches are attached to it, and the
    /// collateral (if any) must be hers, active and not already pledged.
    #[allow(clippy::too_many_arguments)]
    pub fn loan_open(
        env: Env,
        caller: Address,
        loan: BytesN<32>,
        borrower: BytesN<32>,
        lender: Address,
        principal: i128,
        cost: i128,
        repay_bps: u32,
        minimum: i128,
        collateral: Option<BytesN<32>>,
        collateral_pct: u32,
    ) -> Result<(), Error> {
        writer(&env, &caller)?;
        if principal <= 0
            || cost < 0
            || minimum <= 0
            || repay_bps > BPS_DENOMINATOR
            || collateral_pct > MAX_COLLATERAL_PCT
        {
            return Err(Error::InvalidAmount);
        }
        let total = principal.checked_add(cost).ok_or(Error::InvalidAmount)?;
        if minimum > total {
            return Err(Error::InvalidAmount);
        }
        let key = DataKey::Loan(loan.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::LoanExists);
        }
        let now = env.ledger().timestamp();
        if let Some(a) = &collateral {
            let mut asset = load_asset(&env, a)?;
            if asset.owner != borrower
                || asset.status != AssetStatus::Active
                || asset.pledged_to.is_some()
            {
                return Err(Error::CollateralUnavailable);
            }
            asset.pledged_to = Some(loan.clone());
            asset.updated_at = now;
            put(&env, &DataKey::Asset(a.clone()), &asset);
            AssetCollateral {
                asset: a.clone(),
                loan: Some(loan.clone()),
            }
            .publish(&env);
        }
        let vkey = DataKey::Vouches(borrower.clone());
        let vouchers = list(&env, &vkey);
        if !vouchers.is_empty() {
            env.storage().persistent().remove(&vkey);
        }
        let record = Loan {
            borrower: borrower.clone(),
            lender: lender.clone(),
            principal,
            cost,
            total,
            repaid: 0,
            repay_bps,
            minimum,
            collateral: collateral.clone(),
            collateral_pct,
            vouchers: vouchers.clone(),
            status: LoanStatus::Active,
            opened_at: now,
            updated_at: now,
        };
        put(&env, &key, &record);
        push(&env, &DataKey::LoansOf(borrower.clone()), &loan);
        LoanOpened {
            loan,
            borrower,
            lender,
            principal,
            cost,
            total,
            repay_bps,
            minimum,
            collateral,
            collateral_pct,
            vouchers: vouchers.len(),
        }
        .publish(&env);
        Ok(())
    }

    /// A repayment that landed (the NGNT payment itself is a separate Stellar transaction,
    /// `payment_ref` points to it). Reaching the total marks the loan Repaid. Never more than owed.
    pub fn loan_repay(
        env: Env,
        caller: Address,
        loan: BytesN<32>,
        amount: i128,
        payment_ref: BytesN<32>,
    ) -> Result<(), Error> {
        writer(&env, &caller)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut l = load_loan(&env, &loan)?;
        if !l.status.is_open() {
            return Err(Error::LoanClosed);
        }
        let repaid = l.repaid.checked_add(amount).ok_or(Error::InvalidAmount)?;
        if repaid > l.total {
            return Err(Error::Overpayment);
        }
        l.repaid = repaid;
        l.updated_at = env.ledger().timestamp();
        put(&env, &DataKey::Loan(loan.clone()), &l);
        LoanRepayment {
            loan: loan.clone(),
            amount,
            repaid,
            total: l.total,
            payment_ref,
        }
        .publish(&env);
        if repaid == l.total {
            set_loan_status(&env, &loan, &mut l, LoanStatus::Repaid);
        }
        Ok(())
    }

    /// Late, Restructured, back to Active, Default or Cancelled. Only open loans move; setting
    /// the status it already has does nothing.
    pub fn loan_set_status(
        env: Env,
        caller: Address,
        loan: BytesN<32>,
        status: LoanStatus,
    ) -> Result<(), Error> {
        writer(&env, &caller)?;
        let mut l = load_loan(&env, &loan)?;
        if l.status == status {
            return Ok(());
        }
        if !may_move(l.status, status) {
            return Err(Error::InvalidTransition);
        }
        set_loan_status(&env, &loan, &mut l, status);
        Ok(())
    }

    // ----- assets ----------------------------------------------------------

    pub fn asset_register(
        env: Env,
        caller: Address,
        asset: BytesN<32>,
        owner: BytesN<32>,
        verification: BytesN<32>,
        level: AssetLevel,
    ) -> Result<(), Error> {
        writer(&env, &caller)?;
        let key = DataKey::Asset(asset.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AssetExists);
        }
        let now = env.ledger().timestamp();
        put(
            &env,
            &key,
            &Asset {
                owner: owner.clone(),
                verification: verification.clone(),
                level,
                status: AssetStatus::Active,
                pledged_to: None,
                registered_at: now,
                updated_at: now,
            },
        );
        push(&env, &DataKey::AssetsOf(owner.clone()), &asset);
        AssetRegistered {
            asset,
            owner,
            level,
            verification,
        }
        .publish(&env);
        Ok(())
    }

    /// A new verification level (levels only go up) and its evidence hash.
    pub fn asset_set_level(
        env: Env,
        caller: Address,
        asset: BytesN<32>,
        level: AssetLevel,
        verification: BytesN<32>,
    ) -> Result<(), Error> {
        writer(&env, &caller)?;
        let mut a = load_asset(&env, &asset)?;
        if a.status == AssetStatus::Released {
            return Err(Error::InvalidTransition);
        }
        if level < a.level {
            return Err(Error::LevelDown);
        }
        if level == a.level && verification == a.verification {
            return Ok(());
        }
        let from = a.level;
        a.level = level;
        a.verification = verification.clone();
        a.updated_at = env.ledger().timestamp();
        put(&env, &DataKey::Asset(asset.clone()), &a);
        AssetLevelChanged {
            asset,
            from,
            to: level,
            verification,
        }
        .publish(&env);
        Ok(())
    }

    /// Active, under review, lost, stolen, damaged (and back), or released (final, and only when
    /// it secures no open loan).
    pub fn asset_set_status(
        env: Env,
        caller: Address,
        asset: BytesN<32>,
        status: AssetStatus,
    ) -> Result<(), Error> {
        writer(&env, &caller)?;
        let mut a = load_asset(&env, &asset)?;
        if a.status == status {
            return Ok(());
        }
        if a.status == AssetStatus::Released {
            return Err(Error::InvalidTransition);
        }
        if status == AssetStatus::Released {
            if let Some(l) = &a.pledged_to {
                if load_loan(&env, l)
                    .map(|l| l.status.is_open())
                    .unwrap_or(false)
                {
                    return Err(Error::AssetPledged);
                }
            }
        }
        let from = a.status;
        a.status = status;
        a.updated_at = env.ledger().timestamp();
        put(&env, &DataKey::Asset(asset.clone()), &a);
        AssetStatusChanged {
            asset,
            from,
            to: status,
        }
        .publish(&env);
        Ok(())
    }

    // ----- vouches ---------------------------------------------------------

    /// An ajo member vouches for the borrower's next loan (eligibility is checked by Plus before
    /// it writes). The vouch waits here and is attached to her next `loan_open`.
    pub fn vouch(
        env: Env,
        caller: Address,
        borrower: BytesN<32>,
        voucher: BytesN<32>,
    ) -> Result<(), Error> {
        writer(&env, &caller)?;
        if voucher == borrower {
            return Err(Error::SelfVouch);
        }
        let key = DataKey::Vouches(borrower.clone());
        let mut v = list(&env, &key);
        if v.contains(&voucher) {
            return Err(Error::AlreadyVouched);
        }
        if v.len() >= MAX_VOUCHES {
            return Err(Error::TooManyVouches);
        }
        v.push_back(voucher.clone());
        put(&env, &key, &v);
        Vouched { borrower, voucher }.publish(&env);
        Ok(())
    }

    pub fn vouch_revoke(
        env: Env,
        caller: Address,
        borrower: BytesN<32>,
        voucher: BytesN<32>,
    ) -> Result<(), Error> {
        writer(&env, &caller)?;
        let key = DataKey::Vouches(borrower.clone());
        let mut v = list(&env, &key);
        let i = v.first_index_of(&voucher).ok_or(Error::VouchNotFound)?;
        v.remove(i);
        if v.is_empty() {
            env.storage().persistent().remove(&key);
        } else {
            put(&env, &key, &v);
        }
        VouchRevoked { borrower, voucher }.publish(&env);
        Ok(())
    }

    // ----- reads (public) --------------------------------------------------

    pub fn config(env: Env) -> Config {
        Config {
            admin: access_control::get_admin(&env).unwrap(),
            partner: partner(&env),
        }
    }

    pub fn loan(env: Env, loan: BytesN<32>) -> Result<Loan, Error> {
        load_loan(&env, &loan)
    }

    /// Her loans, oldest first.
    pub fn loans_of(env: Env, borrower: BytesN<32>) -> Vec<BytesN<32>> {
        list(&env, &DataKey::LoansOf(borrower))
    }

    pub fn asset(env: Env, asset: BytesN<32>) -> Result<Asset, Error> {
        load_asset(&env, &asset)
    }

    pub fn assets_of(env: Env, owner: BytesN<32>) -> Vec<BytesN<32>> {
        list(&env, &DataKey::AssetsOf(owner))
    }

    /// Vouches waiting for her next loan.
    pub fn vouches_for(env: Env, borrower: BytesN<32>) -> Vec<BytesN<32>> {
        list(&env, &DataKey::Vouches(borrower))
    }
}

/// OpenZeppelin access control: admin transfer and role views.
#[contractimpl(contracttrait)]
impl AccessControl for PlusCredit {}

mod test;
