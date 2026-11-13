#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, IntoVal, Val, Vec,
};

/// ₦1 with 7 decimals.
const N: i128 = 10_000_000;
const NOW: u64 = 1_700_000_000;
const DUE: u64 = NOW + 30 * 86_400;
const PRINCIPAL: i128 = 30_000 * N;
const TOTAL: i128 = 31_800 * N;

struct Setup<'a> {
    env: Env,
    c: LoanEscrowClient<'a>,
    id: Address,
    admin: Address,
    lender: Address,
    borrower: Address,
    token: TokenClient<'a>,
    sac: StellarAssetClient<'a>,
}

impl<'a> Setup<'a> {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(NOW);
        let admin = Address::generate(&env);
        let lender = Address::generate(&env);
        let borrower = Address::generate(&env);
        let issuer = Address::generate(&env);
        let t = env.register_stellar_asset_contract_v2(issuer);
        let token = TokenClient::new(&env, &t.address());
        let sac = StellarAssetClient::new(&env, &t.address());
        // The lender has ₦100,000; the borrower ₦5,000 (to repay with, beyond the loan).
        sac.mint(&lender, &(100_000 * N));
        sac.mint(&borrower, &(5_000 * N));
        let id = env.register(LoanEscrow, (admin.clone(), t.address()));
        let c = LoanEscrowClient::new(&env, &id);
        Setup {
            env,
            c,
            id,
            admin,
            lender,
            borrower,
            token,
            sac,
        }
    }

    fn r(&self, b: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[b; 32])
    }

    /// ₦30,000 loan, ₦31,800 due in 30 days.
    fn create(&self, loan: u8) {
        self.c.create_loan(
            &self.r(loan),
            &self.lender,
            &self.borrower,
            &PRINCIPAL,
            &TOTAL,
            &DUE,
        );
    }

    fn open(&self, loan: u8) {
        self.c.open_funded(
            &self.r(loan),
            &self.lender,
            &self.borrower,
            &PRINCIPAL,
            &TOTAL,
            &DUE,
        );
    }

    /// (lender, contract, borrower) balances.
    fn balances(&self) -> (i128, i128, i128) {
        (
            self.token.balance(&self.lender),
            self.token.balance(&self.id),
            self.token.balance(&self.borrower),
        )
    }

    /// Number of events this contract published in the last call (token events excluded).
    fn events(&self) -> u32 {
        self.env
            .events()
            .all()
            .filter_by_contract(&self.id)
            .events()
            .len() as u32
    }

    /// Who signed the last call (top-level signers, in order).
    fn signers(&self) -> std::vec::Vec<Address> {
        self.env.auths().into_iter().map(|(a, _)| a).collect()
    }

    fn state(&self, loan: u8) -> LoanState {
        self.c.loan(&self.r(loan)).state
    }

    fn mock(&self, address: &Address, fn_name: &'static str, args: Vec<Val>) {
        self.env.mock_auths(&[MockAuth {
            address,
            invoke: &MockAuthInvoke {
                contract: &self.id,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }
}

const LOAN: u8 = 1;
const L0: (i128, i128, i128) = (100_000 * N, 0, 5_000 * N);

// ----- setup -------------------------------------------------------------------------

#[test]
fn config_is_public() {
    let s = Setup::new();
    let cfg = s.c.config();
    assert_eq!(cfg.admin, s.admin);
    assert_eq!(cfg.token, s.token.address);
    assert_eq!(s.c.try_loan(&s.r(9)), Err(Ok(Error::LoanNotFound)));
}

// ----- happy path ----------------------------------------------------------------------

#[test]
fn happy_path_create_fund_disburse_repay_close() {
    let s = Setup::new();
    let l = s.r(LOAN);

    s.create(LOAN);
    assert_eq!(s.events(), 1); // LoanCreated
    let loan = s.c.loan(&l);
    assert_eq!(loan.lender, s.lender);
    assert_eq!(loan.borrower, s.borrower);
    assert_eq!(
        (loan.principal, loan.total_due, loan.repaid, loan.due_ts),
        (PRINCIPAL, TOTAL, 0, DUE)
    );
    assert_eq!((loan.created_at, loan.updated_at), (NOW, NOW));
    assert_eq!(loan.state, LoanState::Created);
    assert_eq!(s.balances(), L0); // no money moved

    s.env.ledger().set_timestamp(NOW + 10);
    s.c.fund(&l);
    assert_eq!(s.events(), 1); // LoanFunded
    assert_eq!(s.state(LOAN), LoanState::Funded);
    assert_eq!(s.c.loan(&l).updated_at, NOW + 10);
    assert_eq!(s.balances(), (70_000 * N, PRINCIPAL, 5_000 * N));

    s.c.disburse(&l);
    assert_eq!(s.events(), 1); // LoanDisbursed
    assert_eq!(s.state(LOAN), LoanState::Active);
    assert_eq!(s.balances(), (70_000 * N, 0, 35_000 * N));

    // Partial: ₦3,000 straight to the lender, the contract never touches it.
    s.c.repay(&l, &s.borrower, &(3_000 * N));
    assert_eq!(s.events(), 1); // LoanRepayment
    let loan = s.c.loan(&l);
    assert_eq!((loan.repaid, loan.state), (3_000 * N, LoanState::Active));
    assert_eq!(s.balances(), (73_000 * N, 0, 32_000 * N));

    // The rest.
    s.c.repay(&l, &s.borrower, &(28_800 * N));
    assert_eq!(s.events(), 2); // LoanRepayment + LoanRepaid
    let loan = s.c.loan(&l);
    assert_eq!((loan.repaid, loan.state), (TOTAL, LoanState::Repaid));
    assert_eq!(s.balances(), (101_800 * N, 0, 3_200 * N));

    s.c.close_loan(&l);
    assert_eq!(s.events(), 1); // LoanClosed
    assert_eq!(s.state(LOAN), LoanState::Closed);
    // The record stays readable.
    assert_eq!(s.c.loan(&l).repaid, TOTAL);
}

#[test]
fn open_funded_does_all_three_in_one_call() {
    let s = Setup::new();
    s.open(LOAN);
    assert_eq!(s.events(), 3); // LoanCreated + LoanFunded + LoanDisbursed
    let loan = s.c.loan(&s.r(LOAN));
    assert_eq!(loan.state, LoanState::Active);
    assert_eq!(
        (loan.principal, loan.total_due, loan.repaid),
        (PRINCIPAL, TOTAL, 0)
    );
    assert_eq!(s.balances(), (70_000 * N, 0, 35_000 * N));
    s.c.repay(&s.r(LOAN), &s.borrower, &TOTAL);
    assert_eq!(s.state(LOAN), LoanState::Repaid);
    assert_eq!(s.balances(), (101_800 * N, 0, 3_200 * N));
}

#[test]
fn open_funded_refusals_leave_nothing_behind() {
    let s = Setup::new();
    let l = s.r(LOAN);
    assert_eq!(
        s.c.try_open_funded(&l, &s.lender, &s.borrower, &0, &TOTAL, &DUE),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        s.c.try_open_funded(
            &l,
            &s.lender,
            &s.borrower,
            &PRINCIPAL,
            &(PRINCIPAL - 1),
            &DUE
        ),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        s.c.try_open_funded(&l, &s.lender, &s.borrower, &PRINCIPAL, &TOTAL, &NOW),
        Err(Ok(Error::InvalidDueDate))
    );
    // A lender without the money: the whole call fails, no loan is recorded.
    let poor = Address::generate(&s.env);
    assert!(s
        .c
        .try_open_funded(&l, &poor, &s.borrower, &PRINCIPAL, &TOTAL, &DUE)
        .is_err());
    assert_eq!(s.c.try_loan(&l), Err(Ok(Error::LoanNotFound)));
    assert_eq!(s.balances(), L0);
    s.open(LOAN);
    assert_eq!(
        s.c.try_open_funded(&l, &s.lender, &s.borrower, &PRINCIPAL, &TOTAL, &DUE),
        Err(Ok(Error::LoanExists))
    );
    // Same id through create_loan: also a duplicate.
    assert_eq!(
        s.c.try_create_loan(&l, &s.lender, &s.borrower, &PRINCIPAL, &TOTAL, &DUE),
        Err(Ok(Error::LoanExists))
    );
}

// ----- create refusals -------------------------------------------------------------------

#[test]
fn create_refusals() {
    let s = Setup::new();
    let (l, a, b) = (s.r(LOAN), &s.lender, &s.borrower);
    let bad = Err(Ok(Error::InvalidAmount));
    assert_eq!(s.c.try_create_loan(&l, a, b, &0, &TOTAL, &DUE), bad);
    assert_eq!(s.c.try_create_loan(&l, a, b, &-N, &TOTAL, &DUE), bad);
    assert_eq!(s.c.try_create_loan(&l, a, b, &N, &0, &DUE), bad);
    assert_eq!(s.c.try_create_loan(&l, a, b, &N, &-N, &DUE), bad);
    // total_due below the principal.
    assert_eq!(s.c.try_create_loan(&l, a, b, &N, &(N - 1), &DUE), bad);
    // Due now or in the past.
    assert_eq!(
        s.c.try_create_loan(&l, a, b, &N, &N, &NOW),
        Err(Ok(Error::InvalidDueDate))
    );
    assert_eq!(
        s.c.try_create_loan(&l, a, b, &N, &N, &0),
        Err(Ok(Error::InvalidDueDate))
    );
    // total_due == principal (an interest-free loan) is fine.
    s.c.create_loan(&l, a, b, &N, &N, &(NOW + 1));
    // Duplicate id, even with other terms or parties.
    let other = Address::generate(&s.env);
    assert_eq!(
        s.c.try_create_loan(&l, &other, b, &PRINCIPAL, &TOTAL, &DUE),
        Err(Ok(Error::LoanExists))
    );
    // The first record is untouched.
    assert_eq!(s.c.loan(&l).principal, N);
}

// ----- wrong states ----------------------------------------------------------------------

#[test]
fn every_wrong_state_transition_is_refused() {
    let s = Setup::new();
    let ws = Err(Ok(Error::WrongState));
    let nf = Err(Ok(Error::LoanNotFound));
    let id = |n: u8| s.r(n);

    // Unknown loan.
    assert_eq!(s.c.try_fund(&id(9)), nf);
    assert_eq!(s.c.try_disburse(&id(9)), nf);
    assert_eq!(s.c.try_repay(&id(9), &s.borrower, &N), nf);
    assert_eq!(s.c.try_cancel_unfunded(&id(9), &s.admin), nf);
    assert_eq!(s.c.try_close_loan(&id(9)), nf);

    // Created: only fund or cancel.
    s.create(1);
    assert_eq!(s.c.try_disburse(&id(1)), ws);
    assert_eq!(s.c.try_repay(&id(1), &s.borrower, &N), ws);
    assert_eq!(s.c.try_close_loan(&id(1)), ws);

    // Funded: only disburse (a second fund is refused, see below).
    s.c.fund(&id(1));
    assert_eq!(s.c.try_fund(&id(1)), ws);
    assert_eq!(s.c.try_repay(&id(1), &s.borrower, &N), ws);
    assert_eq!(s.c.try_cancel_unfunded(&id(1), &s.admin), ws);
    assert_eq!(s.c.try_close_loan(&id(1)), ws);

    // Active: only repay.
    s.c.disburse(&id(1));
    assert_eq!(s.c.try_fund(&id(1)), ws);
    assert_eq!(s.c.try_disburse(&id(1)), ws);
    assert_eq!(s.c.try_cancel_unfunded(&id(1), &s.lender), ws);
    assert_eq!(s.c.try_close_loan(&id(1)), ws);

    // Repaid: only close.
    s.c.repay(&id(1), &s.borrower, &TOTAL);
    assert_eq!(s.c.try_fund(&id(1)), ws);
    assert_eq!(s.c.try_disburse(&id(1)), ws);
    assert_eq!(s.c.try_repay(&id(1), &s.borrower, &N), ws);
    assert_eq!(s.c.try_cancel_unfunded(&id(1), &s.admin), ws);

    // Closed: final.
    s.c.close_loan(&id(1));
    assert_eq!(s.c.try_fund(&id(1)), ws);
    assert_eq!(s.c.try_disburse(&id(1)), ws);
    assert_eq!(s.c.try_repay(&id(1), &s.borrower, &N), ws);
    assert_eq!(s.c.try_cancel_unfunded(&id(1), &s.admin), ws);
    assert_eq!(s.c.try_close_loan(&id(1)), ws);

    // Cancelled: final.
    s.create(2);
    s.c.cancel_unfunded(&id(2), &s.admin);
    assert_eq!(s.c.try_fund(&id(2)), ws);
    assert_eq!(s.c.try_disburse(&id(2)), ws);
    assert_eq!(s.c.try_repay(&id(2), &s.borrower, &N), ws);
    assert_eq!(s.c.try_cancel_unfunded(&id(2), &s.admin), ws);
    assert_eq!(s.c.try_close_loan(&id(2)), ws);
}

#[test]
fn a_second_fund_moves_no_money() {
    let s = Setup::new();
    s.create(LOAN);
    s.c.fund(&s.r(LOAN));
    let after_first = s.balances();
    assert_eq!(s.c.try_fund(&s.r(LOAN)), Err(Ok(Error::WrongState)));
    assert_eq!(s.balances(), after_first);
    assert_eq!(s.state(LOAN), LoanState::Funded);
}

#[test]
fn fund_without_the_money_fails_and_stays_created() {
    let s = Setup::new();
    let poor = Address::generate(&s.env);
    s.c.create_loan(&s.r(LOAN), &poor, &s.borrower, &PRINCIPAL, &TOTAL, &DUE);
    assert!(s.c.try_fund(&s.r(LOAN)).is_err());
    assert_eq!(s.state(LOAN), LoanState::Created);
    assert_eq!(s.token.balance(&s.id), 0);
}

// ----- repay -------------------------------------------------------------------------------

#[test]
fn repay_refusals_and_overpay() {
    let s = Setup::new();
    let l = s.r(LOAN);
    s.open(LOAN);
    let b = &s.borrower;
    assert_eq!(s.c.try_repay(&l, b, &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(s.c.try_repay(&l, b, &-N), Err(Ok(Error::InvalidAmount)));
    // More than she owes.
    assert_eq!(s.c.try_repay(&l, b, &(TOTAL + 1)), Err(Ok(Error::Overpay)));
    assert_eq!(s.c.try_repay(&l, b, &i128::MAX), Err(Ok(Error::Overpay)));
    s.c.repay(&l, b, &(31_000 * N));
    assert_eq!(s.c.try_repay(&l, b, &(801 * N)), Err(Ok(Error::Overpay)));
    // Refusals move nothing.
    assert_eq!(s.balances(), (101_000 * N, 0, 4_000 * N));
    assert_eq!(s.c.loan(&l).repaid, 31_000 * N);
    // Exactly the outstanding amount closes it.
    s.c.repay(&l, b, &(800 * N));
    assert_eq!(s.state(LOAN), LoanState::Repaid);
}

#[test]
fn someone_else_may_repay_for_her() {
    let s = Setup::new();
    s.open(LOAN);
    let sister = Address::generate(&s.env);
    s.sac.mint(&sister, &(2_000 * N));
    s.c.repay(&s.r(LOAN), &sister, &(2_000 * N));
    assert_eq!(s.signers(), std::vec![sister.clone()]);
    assert_eq!(s.token.balance(&sister), 0);
    assert_eq!(s.token.balance(&s.lender), 72_000 * N);
    assert_eq!(s.c.loan(&s.r(LOAN)).repaid, 2_000 * N);
}

#[test]
fn repay_without_the_money_fails_and_records_nothing() {
    let s = Setup::new();
    s.open(LOAN);
    // She has ₦35,000 but owes ₦31,800: give away all but ₦100 first.
    let x = Address::generate(&s.env);
    s.token.transfer(&s.borrower, &x, &(34_900 * N));
    assert!(s.c.try_repay(&s.r(LOAN), &s.borrower, &(200 * N)).is_err());
    assert_eq!(s.c.loan(&s.r(LOAN)).repaid, 0);
}

// ----- cancel ------------------------------------------------------------------------------

#[test]
fn cancel_unfunded_by_admin_or_lender_only() {
    let s = Setup::new();
    s.create(1);
    s.create(2);
    s.c.cancel_unfunded(&s.r(1), &s.admin);
    assert_eq!(s.events(), 1); // LoanCancelled
    assert_eq!(s.signers(), std::vec![s.admin.clone()]);
    assert_eq!(s.state(1), LoanState::Cancelled);
    s.c.cancel_unfunded(&s.r(2), &s.lender);
    assert_eq!(s.signers(), std::vec![s.lender.clone()]);
    assert_eq!(s.state(2), LoanState::Cancelled);

    // The borrower, or a stranger, may not.
    s.create(3);
    let x = Address::generate(&s.env);
    let na = Err(Ok(Error::NotAuthorized));
    assert_eq!(s.c.try_cancel_unfunded(&s.r(3), &s.borrower), na);
    assert_eq!(s.c.try_cancel_unfunded(&s.r(3), &x), na);
    assert_eq!(s.state(3), LoanState::Created);
    assert_eq!(s.balances(), L0);
}

// ----- auth: exactly whose signature each call needs -------------------------------------

#[test]
fn each_call_records_exactly_its_signers() {
    let s = Setup::new();
    let l = s.r(LOAN);

    s.create(LOAN);
    assert_eq!(
        s.signers(),
        std::vec![s.admin.clone(), s.lender.clone(), s.borrower.clone()]
    );

    s.c.fund(&l);
    assert_eq!(s.signers(), std::vec![s.lender.clone()]);
    // The lender's one signature covers the token transfer under it.
    let (_, inv) = &s.env.auths()[0];
    assert_eq!(inv.sub_invocations.len(), 1);

    s.c.disburse(&l);
    assert_eq!(s.signers(), std::vec![s.admin.clone()]);

    s.c.repay(&l, &s.borrower, &N);
    assert_eq!(s.signers(), std::vec![s.borrower.clone()]);

    s.c.repay(&l, &s.borrower, &(TOTAL - N));
    s.c.close_loan(&l);
    assert_eq!(s.signers(), std::vec![s.admin.clone()]);

    s.open(2);
    assert_eq!(
        s.signers(),
        std::vec![s.admin.clone(), s.lender.clone(), s.borrower.clone()]
    );
    // Only the lender's signature has a sub-invocation (the transfer lender -> contract); the
    // contract's own transfer to the borrower needs no one's signature.
    let auths = s.env.auths();
    assert_eq!(auths[0].1.sub_invocations.len(), 0);
    assert_eq!(auths[1].1.sub_invocations.len(), 1);
    assert_eq!(auths[2].1.sub_invocations.len(), 0);
}

#[test]
fn create_loan_needs_all_three_signatures() {
    let s = Setup::new();
    let l = s.r(LOAN);
    let args: Vec<Val> = (
        l.clone(),
        s.lender.clone(),
        s.borrower.clone(),
        PRINCIPAL,
        TOTAL,
        DUE,
    )
        .into_val(&s.env);
    let parties = [s.admin.clone(), s.lender.clone(), s.borrower.clone()];
    // Any one of the three missing: refused.
    for missing in 0..3 {
        let present: std::vec::Vec<&Address> = parties
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != missing)
            .map(|(_, a)| a)
            .collect();
        let invoke = MockAuthInvoke {
            contract: &s.id,
            fn_name: "create_loan",
            args: args.clone(),
            sub_invokes: &[],
        };
        s.env.mock_auths(&[
            MockAuth {
                address: present[0],
                invoke: &invoke,
            },
            MockAuth {
                address: present[1],
                invoke: &invoke,
            },
        ]);
        assert!(s
            .c
            .try_create_loan(&l, &s.lender, &s.borrower, &PRINCIPAL, &TOTAL, &DUE)
            .is_err());
        assert_eq!(s.c.try_loan(&l), Err(Ok(Error::LoanNotFound)));
    }
    // All three: it goes through.
    let invoke = MockAuthInvoke {
        contract: &s.id,
        fn_name: "create_loan",
        args: args.clone(),
        sub_invokes: &[],
    };
    s.env.mock_auths(&[
        MockAuth {
            address: &s.admin,
            invoke: &invoke,
        },
        MockAuth {
            address: &s.lender,
            invoke: &invoke,
        },
        MockAuth {
            address: &s.borrower,
            invoke: &invoke,
        },
    ]);
    s.c.create_loan(&l, &s.lender, &s.borrower, &PRINCIPAL, &TOTAL, &DUE);
    assert_eq!(s.state(LOAN), LoanState::Created);
}

#[test]
fn fund_needs_the_lenders_signature_over_the_transfer() {
    let s = Setup::new();
    let l = s.r(LOAN);
    s.create(LOAN);

    // Nobody signs: refused.
    s.env.set_auths(&[]);
    assert!(s.c.try_fund(&l).is_err());
    // The admin or the borrower cannot fund in the lender's place.
    s.mock(&s.admin, "fund", (l.clone(),).into_val(&s.env));
    assert!(s.c.try_fund(&l).is_err());
    s.mock(&s.borrower, "fund", (l.clone(),).into_val(&s.env));
    assert!(s.c.try_fund(&l).is_err());
    // The lender signing `fund` but not the transfer under it: refused.
    s.mock(&s.lender, "fund", (l.clone(),).into_val(&s.env));
    assert!(s.c.try_fund(&l).is_err());
    assert_eq!(s.state(LOAN), LoanState::Created);
    assert_eq!(s.balances(), L0);

    // The lender signing both: funded.
    s.env.mock_auths(&[MockAuth {
        address: &s.lender,
        invoke: &MockAuthInvoke {
            contract: &s.id,
            fn_name: "fund",
            args: (l.clone(),).into_val(&s.env),
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token.address,
                fn_name: "transfer",
                args: (s.lender.clone(), s.id.clone(), PRINCIPAL).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);
    s.c.fund(&l);
    assert_eq!(s.state(LOAN), LoanState::Funded);
}

#[test]
fn disburse_needs_the_admins_signature() {
    let s = Setup::new();
    let l = s.r(LOAN);
    s.create(LOAN);
    s.c.fund(&l);

    s.env.set_auths(&[]);
    assert!(s.c.try_disburse(&l).is_err());
    s.mock(&s.borrower, "disburse", (l.clone(),).into_val(&s.env));
    assert!(s.c.try_disburse(&l).is_err());
    s.mock(&s.lender, "disburse", (l.clone(),).into_val(&s.env));
    assert!(s.c.try_disburse(&l).is_err());
    assert_eq!(s.state(LOAN), LoanState::Funded);

    s.mock(&s.admin, "disburse", (l.clone(),).into_val(&s.env));
    s.c.disburse(&l);
    assert_eq!(s.state(LOAN), LoanState::Active);
    assert_eq!(s.token.balance(&s.borrower), 35_000 * N);
}

#[test]
fn open_funded_needs_all_three_and_the_lenders_transfer() {
    let s = Setup::new();
    let l = s.r(LOAN);
    let args: Vec<Val> = (
        l.clone(),
        s.lender.clone(),
        s.borrower.clone(),
        PRINCIPAL,
        TOTAL,
        DUE,
    )
        .into_val(&s.env);
    let plain = MockAuthInvoke {
        contract: &s.id,
        fn_name: "open_funded",
        args: args.clone(),
        sub_invokes: &[],
    };
    let transfer = [MockAuthInvoke {
        contract: &s.token.address,
        fn_name: "transfer",
        args: (s.lender.clone(), s.id.clone(), PRINCIPAL).into_val(&s.env),
        sub_invokes: &[],
    }];
    let with_transfer = MockAuthInvoke {
        contract: &s.id,
        fn_name: "open_funded",
        args: args.clone(),
        sub_invokes: &transfer,
    };
    let call = || {
        s.c.try_open_funded(&l, &s.lender, &s.borrower, &PRINCIPAL, &TOTAL, &DUE)
    };

    // Without the admin.
    s.env.mock_auths(&[
        MockAuth {
            address: &s.lender,
            invoke: &with_transfer,
        },
        MockAuth {
            address: &s.borrower,
            invoke: &plain,
        },
    ]);
    assert!(call().is_err());
    // Without the borrower.
    s.env.mock_auths(&[
        MockAuth {
            address: &s.admin,
            invoke: &plain,
        },
        MockAuth {
            address: &s.lender,
            invoke: &with_transfer,
        },
    ]);
    assert!(call().is_err());
    // Without the lender.
    s.env.mock_auths(&[
        MockAuth {
            address: &s.admin,
            invoke: &plain,
        },
        MockAuth {
            address: &s.borrower,
            invoke: &plain,
        },
    ]);
    assert!(call().is_err());
    // The lender signs the call but not the transfer.
    s.env.mock_auths(&[
        MockAuth {
            address: &s.admin,
            invoke: &plain,
        },
        MockAuth {
            address: &s.lender,
            invoke: &plain,
        },
        MockAuth {
            address: &s.borrower,
            invoke: &plain,
        },
    ]);
    assert!(call().is_err());
    assert_eq!(s.c.try_loan(&l), Err(Ok(Error::LoanNotFound)));
    assert_eq!(s.balances(), L0);

    // All of it: one call, Active.
    s.env.mock_auths(&[
        MockAuth {
            address: &s.admin,
            invoke: &plain,
        },
        MockAuth {
            address: &s.lender,
            invoke: &with_transfer,
        },
        MockAuth {
            address: &s.borrower,
            invoke: &plain,
        },
    ]);
    assert_eq!(call(), Ok(Ok(())));
    assert_eq!(s.state(LOAN), LoanState::Active);
    assert_eq!(s.balances(), (70_000 * N, 0, 35_000 * N));
}

#[test]
fn repay_needs_the_payers_signature_over_the_transfer() {
    let s = Setup::new();
    let l = s.r(LOAN);
    s.open(LOAN);
    let args: Vec<Val> = (l.clone(), s.borrower.clone(), N).into_val(&s.env);

    s.env.set_auths(&[]);
    assert!(s.c.try_repay(&l, &s.borrower, &N).is_err());
    // The admin or the lender cannot pull money from her.
    s.mock(&s.admin, "repay", args.clone());
    assert!(s.c.try_repay(&l, &s.borrower, &N).is_err());
    s.mock(&s.lender, "repay", args.clone());
    assert!(s.c.try_repay(&l, &s.borrower, &N).is_err());
    // Her signature on `repay` without the transfer under it.
    s.mock(&s.borrower, "repay", args.clone());
    assert!(s.c.try_repay(&l, &s.borrower, &N).is_err());
    assert_eq!(s.c.loan(&l).repaid, 0);

    s.env.mock_auths(&[MockAuth {
        address: &s.borrower,
        invoke: &MockAuthInvoke {
            contract: &s.id,
            fn_name: "repay",
            args,
            sub_invokes: &[MockAuthInvoke {
                contract: &s.token.address,
                fn_name: "transfer",
                args: (s.borrower.clone(), s.lender.clone(), N).into_val(&s.env),
                sub_invokes: &[],
            }],
        },
    }]);
    s.c.repay(&l, &s.borrower, &N);
    assert_eq!(s.c.loan(&l).repaid, N);
}

#[test]
fn cancel_needs_the_named_callers_signature() {
    let s = Setup::new();
    let l = s.r(LOAN);
    s.create(LOAN);

    // Naming the lender without the lender's signature (the admin signing instead): refused.
    s.env.set_auths(&[]);
    assert!(s.c.try_cancel_unfunded(&l, &s.lender).is_err());
    s.mock(
        &s.admin,
        "cancel_unfunded",
        (l.clone(), s.lender.clone()).into_val(&s.env),
    );
    assert!(s.c.try_cancel_unfunded(&l, &s.lender).is_err());
    assert_eq!(s.state(LOAN), LoanState::Created);

    s.mock(
        &s.lender,
        "cancel_unfunded",
        (l.clone(), s.lender.clone()).into_val(&s.env),
    );
    s.c.cancel_unfunded(&l, &s.lender);
    assert_eq!(s.state(LOAN), LoanState::Cancelled);
}

#[test]
fn close_and_upgrade_need_the_admins_signature() {
    let s = Setup::new();
    let l = s.r(LOAN);
    s.open(LOAN);
    s.c.repay(&l, &s.borrower, &TOTAL);

    s.env.set_auths(&[]);
    assert!(s.c.try_close_loan(&l).is_err());
    s.mock(&s.lender, "close_loan", (l.clone(),).into_val(&s.env));
    assert!(s.c.try_close_loan(&l).is_err());
    s.mock(&s.borrower, "close_loan", (l.clone(),).into_val(&s.env));
    assert!(s.c.try_close_loan(&l).is_err());
    assert_eq!(s.state(LOAN), LoanState::Repaid);
    s.mock(&s.admin, "close_loan", (l.clone(),).into_val(&s.env));
    s.c.close_loan(&l);
    assert_eq!(s.state(LOAN), LoanState::Closed);

    // upgrade: without the admin's signature, refused before anything else.
    s.env.set_auths(&[]);
    assert!(s.c.try_upgrade(&s.r(7)).is_err());
    s.mock(&s.lender, "upgrade", (s.r(7),).into_val(&s.env));
    assert!(s.c.try_upgrade(&s.r(7)).is_err());
}

// ----- TTL ---------------------------------------------------------------------------------

#[test]
fn writes_extend_ttl() {
    use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
    let s = Setup::new();
    let loan_ttl = || {
        s.env.as_contract(&s.id, || {
            s.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Loan(s.r(LOAN)))
        })
    };
    let instance_ttl = || {
        s.env
            .as_contract(&s.id, || s.env.storage().instance().get_ttl())
    };

    s.create(LOAN);
    assert!(loan_ttl() >= TTL_EXTEND_TO - 1);
    assert!(instance_ttl() >= TTL_EXTEND_TO - 1);

    // 100 days later the entry is below the threshold; the next write brings it back up.
    let skip = 100 * DAY_IN_LEDGERS;
    s.env
        .ledger()
        .set_sequence_number(s.env.ledger().sequence() + skip);
    assert!(loan_ttl() < TTL_THRESHOLD);
    s.c.cancel_unfunded(&s.r(LOAN), &s.admin);
    assert!(loan_ttl() >= TTL_EXTEND_TO - 1);
    assert!(instance_ttl() >= TTL_EXTEND_TO - 1);
}

#[test]
fn every_money_write_extends_ttl() {
    use soroban_sdk::testutils::storage::Persistent as _;
    let s = Setup::new();
    let l = s.r(LOAN);
    let loan_ttl = || {
        s.env.as_contract(&s.id, || {
            s.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Loan(l.clone()))
        })
    };
    // Before each step the entry has dropped below the threshold (95 days pass); after it,
    // the TTL is back at the full extension.
    let step = |f: &dyn Fn()| {
        s.env
            .ledger()
            .set_sequence_number(s.env.ledger().sequence() + 95 * DAY_IN_LEDGERS);
        assert!(loan_ttl() < TTL_THRESHOLD);
        f();
        assert!(loan_ttl() >= TTL_EXTEND_TO - 1);
    };
    s.create(LOAN);
    step(&|| s.c.fund(&l));
    step(&|| s.c.disburse(&l));
    step(&|| s.c.repay(&l, &s.borrower, &N));
    step(&|| s.c.repay(&l, &s.borrower, &(TOTAL - N)));
    step(&|| s.c.close_loan(&l));
}
