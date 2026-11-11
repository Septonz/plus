#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal,
};

/// ₦1 with 7 decimals.
const N: i128 = 10_000_000;

struct Setup<'a> {
    env: Env,
    c: PlusCreditClient<'a>,
    id: Address,
    admin: Address,
    partner: Address,
    lender: Address,
}

impl<'a> Setup<'a> {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let partner = Address::generate(&env);
        let lender = Address::generate(&env);
        let id = env.register(PlusCredit, (admin.clone(), partner.clone()));
        let c = PlusCreditClient::new(&env, &id);
        Setup {
            env,
            c,
            id,
            admin,
            partner,
            lender,
        }
    }

    fn r(&self, b: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[b; 32])
    }

    /// Funmi's ₦30,000 loan (cost ₦1,800), 10% of money in, ₦3,000 minimum.
    fn open(&self, loan: u8, borrower: u8, collateral: Option<BytesN<32>>) {
        self.c.loan_open(
            &self.partner,
            &self.r(loan),
            &self.r(borrower),
            &self.lender,
            &(30_000 * N),
            &(1_800 * N),
            &1_000,
            &(3_000 * N),
            &collateral,
            &150,
        );
    }

    fn register(&self, asset: u8, owner: u8) {
        self.c.asset_register(
            &self.partner,
            &self.r(asset),
            &self.r(owner),
            &self.r(200),
            &AssetLevel::Registered,
        );
    }

    /// Number of events the last call published.
    fn events(&self) -> u32 {
        self.env.events().all().events().len() as u32
    }
}

const LOAN: u8 = 1;
const FUNMI: u8 = 10;
const KEMI: u8 = 11;
const AMAKA: u8 = 12;
const STALL: u8 = 50;

// ----- setup and access ----------------------------------------------------------

#[test]
fn config_is_public() {
    let s = Setup::new();
    let cfg = s.c.config();
    assert_eq!(cfg.admin, s.admin);
    assert_eq!(cfg.partner, s.partner);
}

#[test]
fn a_stranger_cannot_write_anything() {
    let s = Setup::new();
    let x = Address::generate(&s.env);
    let e = Err(Ok(Error::NotAuthorized));
    assert_eq!(
        s.c.try_loan_open(
            &x,
            &s.r(LOAN),
            &s.r(FUNMI),
            &s.lender,
            &N,
            &0,
            &0,
            &N,
            &None,
            &0
        ),
        e
    );
    s.open(LOAN, FUNMI, None);
    s.register(STALL, FUNMI);
    assert_eq!(s.c.try_loan_repay(&x, &s.r(LOAN), &N, &s.r(90)), e);
    assert_eq!(
        s.c.try_loan_set_status(&x, &s.r(LOAN), &LoanStatus::Late),
        e
    );
    assert_eq!(
        s.c.try_asset_register(
            &x,
            &s.r(51),
            &s.r(FUNMI),
            &s.r(200),
            &AssetLevel::Registered
        ),
        e
    );
    assert_eq!(
        s.c.try_asset_set_level(&x, &s.r(STALL), &AssetLevel::EvidenceVerified, &s.r(201)),
        e
    );
    assert_eq!(
        s.c.try_asset_set_status(&x, &s.r(STALL), &AssetStatus::Lost),
        e
    );
    assert_eq!(s.c.try_vouch(&x, &s.r(FUNMI), &s.r(AMAKA)), e);
    assert_eq!(s.c.try_vouch_revoke(&x, &s.r(FUNMI), &s.r(AMAKA)), e);
    // The borrower (as an account) is not a writer either.
    assert_eq!(
        s.c.try_loan_set_status(&s.lender, &s.r(LOAN), &LoanStatus::Default),
        e
    );
}

#[test]
fn every_write_needs_the_callers_signature() {
    let s = Setup::new();
    s.open(LOAN, FUNMI, None);
    assert_eq!(s.env.auths()[0].0, s.partner);

    // The partner's address alone, without its signature, is refused.
    s.env.set_auths(&[]);
    assert!(s
        .c
        .try_loan_set_status(&s.partner, &s.r(LOAN), &LoanStatus::Late)
        .is_err());
    assert!(s
        .c
        .try_loan_repay(&s.partner, &s.r(LOAN), &N, &s.r(90))
        .is_err());
    assert_eq!(s.c.loan(&s.r(LOAN)).status, LoanStatus::Active);
    assert_eq!(s.c.loan(&s.r(LOAN)).repaid, 0);

    // With exactly the partner's signature for this call, it goes through.
    s.env.mock_auths(&[MockAuth {
        address: &s.partner,
        invoke: &MockAuthInvoke {
            contract: &s.id,
            fn_name: "loan_set_status",
            args: (s.partner.clone(), s.r(LOAN), LoanStatus::Late).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    s.c.loan_set_status(&s.partner, &s.r(LOAN), &LoanStatus::Late);
    assert_eq!(s.c.loan(&s.r(LOAN)).status, LoanStatus::Late);
}

#[test]
fn the_admin_can_write_too() {
    let s = Setup::new();
    s.c.loan_open(
        &s.admin,
        &s.r(LOAN),
        &s.r(FUNMI),
        &s.lender,
        &N,
        &0,
        &0,
        &N,
        &None,
        &0,
    );
    assert_eq!(s.env.auths()[0].0, s.admin);
    s.c.loan_repay(&s.admin, &s.r(LOAN), &N, &s.r(90));
    assert_eq!(s.c.loan(&s.r(LOAN)).status, LoanStatus::Repaid);
}

#[test]
fn set_partner_is_admin_only_and_switches_the_writer() {
    let s = Setup::new();
    let p2 = Address::generate(&s.env);
    s.c.set_partner(&p2);
    assert_eq!(s.env.auths()[0].0, s.admin);
    assert_eq!(s.c.config().partner, p2);
    // The old partner can no longer write.
    assert_eq!(
        s.c.try_vouch(&s.partner, &s.r(FUNMI), &s.r(AMAKA)),
        Err(Ok(Error::NotAuthorized))
    );
    s.c.vouch(&p2, &s.r(FUNMI), &s.r(AMAKA));

    // Without the admin's signature: refused.
    s.env.set_auths(&[]);
    assert!(s.c.try_set_partner(&s.partner).is_err());
    assert!(s.c.try_upgrade(&s.r(7)).is_err());
}

// ----- loans -----------------------------------------------------------------------

#[test]
fn loan_open_records_the_agreement() {
    let s = Setup::new();
    s.open(LOAN, FUNMI, None);
    assert_eq!(s.events(), 1); // LoanOpened
    let l = s.c.loan(&s.r(LOAN));
    assert_eq!(l.borrower, s.r(FUNMI));
    assert_eq!(l.lender, s.lender);
    assert_eq!(
        (l.principal, l.cost, l.total, l.repaid),
        (30_000 * N, 1_800 * N, 31_800 * N, 0)
    );
    assert_eq!(
        (l.repay_bps, l.minimum, l.collateral_pct),
        (1_000, 3_000 * N, 150)
    );
    assert_eq!(l.status, LoanStatus::Active);
    assert_eq!(l.collateral, None);
    assert_eq!(l.vouchers.len(), 0);
    assert_eq!(
        s.c.loans_of(&s.r(FUNMI)),
        soroban_sdk::vec![&s.env, s.r(LOAN)]
    );
    assert_eq!(s.c.loans_of(&s.r(KEMI)).len(), 0);
}

#[test]
fn loan_open_refusals() {
    let s = Setup::new();
    let p = &s.partner;
    let (l, b) = (s.r(LOAN), s.r(FUNMI));
    let bad = Err(Ok(Error::InvalidAmount));
    assert_eq!(
        s.c.try_loan_open(p, &l, &b, &s.lender, &0, &0, &0, &N, &None, &0),
        bad
    ); // no principal
    assert_eq!(
        s.c.try_loan_open(p, &l, &b, &s.lender, &N, &-1, &0, &N, &None, &0),
        bad
    ); // negative cost
    assert_eq!(
        s.c.try_loan_open(p, &l, &b, &s.lender, &N, &0, &0, &0, &None, &0),
        bad
    ); // no minimum
    assert_eq!(
        s.c.try_loan_open(p, &l, &b, &s.lender, &N, &0, &0, &(2 * N), &None, &0),
        bad
    ); // minimum > total
    assert_eq!(
        s.c.try_loan_open(p, &l, &b, &s.lender, &N, &0, &10_001, &N, &None, &0),
        bad
    ); // over 100%
    assert_eq!(
        s.c.try_loan_open(p, &l, &b, &s.lender, &N, &0, &0, &N, &None, &301),
        bad
    ); // collateral over 300%
    assert_eq!(
        s.c.try_loan_open(p, &l, &b, &s.lender, &i128::MAX, &1, &0, &N, &None, &0),
        bad
    ); // overflow
    s.open(LOAN, FUNMI, None);
    assert_eq!(
        s.c.try_loan_open(p, &l, &s.r(KEMI), &s.lender, &N, &0, &0, &N, &None, &0),
        Err(Ok(Error::LoanExists))
    );
    // Collateral that doesn't exist.
    assert_eq!(
        s.c.try_loan_open(
            p,
            &s.r(2),
            &b,
            &s.lender,
            &N,
            &0,
            &0,
            &N,
            &Some(s.r(STALL)),
            &150
        ),
        Err(Ok(Error::AssetNotFound))
    );
}

#[test]
fn repayments_add_up_and_close_the_loan() {
    let s = Setup::new();
    s.open(LOAN, FUNMI, None);
    s.c.loan_repay(&s.partner, &s.r(LOAN), &(3_000 * N), &s.r(90));
    assert_eq!(s.events(), 1); // LoanRepayment
    let l = s.c.loan(&s.r(LOAN));
    assert_eq!((l.repaid, l.status), (3_000 * N, LoanStatus::Active));
    s.c.loan_repay(&s.partner, &s.r(LOAN), &(28_800 * N), &s.r(91));
    assert_eq!(s.events(), 2); // LoanRepayment + LoanStatusChanged
    let l = s.c.loan(&s.r(LOAN));
    assert_eq!((l.repaid, l.status), (31_800 * N, LoanStatus::Repaid));
}

#[test]
fn repay_refusals() {
    let s = Setup::new();
    let p = &s.partner;
    assert_eq!(
        s.c.try_loan_repay(p, &s.r(9), &N, &s.r(90)),
        Err(Ok(Error::LoanNotFound))
    );
    s.open(LOAN, FUNMI, None);
    assert_eq!(
        s.c.try_loan_repay(p, &s.r(LOAN), &0, &s.r(90)),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        s.c.try_loan_repay(p, &s.r(LOAN), &-N, &s.r(90)),
        Err(Ok(Error::InvalidAmount))
    );
    // More than she owes.
    assert_eq!(
        s.c.try_loan_repay(p, &s.r(LOAN), &(31_800 * N + 1), &s.r(90)),
        Err(Ok(Error::Overpayment))
    );
    s.c.loan_repay(p, &s.r(LOAN), &(31_000 * N), &s.r(90));
    assert_eq!(
        s.c.try_loan_repay(p, &s.r(LOAN), &(801 * N), &s.r(91)),
        Err(Ok(Error::Overpayment))
    );
    assert_eq!(
        s.c.try_loan_repay(p, &s.r(LOAN), &i128::MAX, &s.r(91)),
        Err(Ok(Error::InvalidAmount))
    );
    s.c.loan_repay(p, &s.r(LOAN), &(800 * N), &s.r(91));
    // Repaid: nothing more goes in.
    assert_eq!(
        s.c.try_loan_repay(p, &s.r(LOAN), &N, &s.r(92)),
        Err(Ok(Error::LoanClosed))
    );
    // A cancelled or defaulted loan takes no repayments either.
    s.open(2, KEMI, None);
    s.c.loan_set_status(p, &s.r(2), &LoanStatus::Cancelled);
    assert_eq!(
        s.c.try_loan_repay(p, &s.r(2), &N, &s.r(93)),
        Err(Ok(Error::LoanClosed))
    );
}

#[test]
fn status_moves_between_open_states() {
    let s = Setup::new();
    let p = &s.partner;
    s.open(LOAN, FUNMI, None);
    for to in [
        LoanStatus::Late,
        LoanStatus::Restructured,
        LoanStatus::Late,
        LoanStatus::Active,
        LoanStatus::Restructured,
        LoanStatus::Active,
    ] {
        s.c.loan_set_status(p, &s.r(LOAN), &to);
        assert_eq!(s.events(), 1);
        assert_eq!(s.c.loan(&s.r(LOAN)).status, to);
    }
    // The same status again: nothing changes, no event.
    s.c.loan_set_status(p, &s.r(LOAN), &LoanStatus::Active);
    assert_eq!(s.events(), 0);
    s.c.loan_set_status(p, &s.r(LOAN), &LoanStatus::Default);
    assert_eq!(s.c.loan(&s.r(LOAN)).status, LoanStatus::Default);
}

#[test]
fn invalid_status_changes_are_refused() {
    let s = Setup::new();
    let p = &s.partner;
    let bad = Err(Ok(Error::InvalidTransition));
    assert_eq!(
        s.c.try_loan_set_status(p, &s.r(9), &LoanStatus::Late),
        Err(Ok(Error::LoanNotFound))
    );

    // Repaid comes only from repayments.
    s.open(LOAN, FUNMI, None);
    assert_eq!(
        s.c.try_loan_set_status(p, &s.r(LOAN), &LoanStatus::Repaid),
        bad
    );

    // Repaid back to Active (or anything else) is refused.
    s.c.loan_repay(p, &s.r(LOAN), &(31_800 * N), &s.r(90));
    for to in [
        LoanStatus::Active,
        LoanStatus::Late,
        LoanStatus::Restructured,
        LoanStatus::Default,
        LoanStatus::Cancelled,
    ] {
        assert_eq!(s.c.try_loan_set_status(p, &s.r(LOAN), &to), bad);
    }
    // Default and Cancelled are final too.
    s.open(2, KEMI, None);
    s.c.loan_set_status(p, &s.r(2), &LoanStatus::Default);
    assert_eq!(
        s.c.try_loan_set_status(p, &s.r(2), &LoanStatus::Active),
        bad
    );
    s.open(3, AMAKA, None);
    s.c.loan_set_status(p, &s.r(3), &LoanStatus::Cancelled);
    assert_eq!(s.c.try_loan_set_status(p, &s.r(3), &LoanStatus::Late), bad);
}

// ----- collateral ------------------------------------------------------------------

#[test]
fn collateral_is_pledged_and_freed_when_repaid() {
    let s = Setup::new();
    let p = &s.partner;
    s.register(STALL, FUNMI);
    s.open(LOAN, FUNMI, Some(s.r(STALL)));
    assert_eq!(s.events(), 2); // AssetCollateral + LoanOpened
    assert_eq!(s.c.asset(&s.r(STALL)).pledged_to, Some(s.r(LOAN)));
    assert_eq!(s.c.loan(&s.r(LOAN)).collateral, Some(s.r(STALL)));
    // Not for a second loan, and not released while it secures one.
    assert_eq!(
        s.c.try_loan_open(
            p,
            &s.r(2),
            &s.r(FUNMI),
            &s.lender,
            &N,
            &0,
            &0,
            &N,
            &Some(s.r(STALL)),
            &150
        ),
        Err(Ok(Error::CollateralUnavailable))
    );
    assert_eq!(
        s.c.try_asset_set_status(p, &s.r(STALL), &AssetStatus::Released),
        Err(Ok(Error::AssetPledged))
    );
    s.c.loan_repay(p, &s.r(LOAN), &(31_800 * N), &s.r(90));
    assert_eq!(s.events(), 3); // LoanRepayment + LoanStatusChanged + AssetCollateral
    assert_eq!(s.c.asset(&s.r(STALL)).pledged_to, None);
    s.c.asset_set_status(p, &s.r(STALL), &AssetStatus::Released);
}

#[test]
fn collateral_freed_when_cancelled_kept_when_defaulted() {
    let s = Setup::new();
    let p = &s.partner;
    s.register(STALL, FUNMI);
    s.open(LOAN, FUNMI, Some(s.r(STALL)));
    s.c.loan_set_status(p, &s.r(LOAN), &LoanStatus::Cancelled);
    assert_eq!(s.c.asset(&s.r(STALL)).pledged_to, None);
    s.open(2, FUNMI, Some(s.r(STALL)));
    s.c.loan_set_status(p, &s.r(2), &LoanStatus::Default);
    assert_eq!(s.c.asset(&s.r(STALL)).pledged_to, Some(s.r(2)));
    // A defaulted loan's collateral may be released afterwards (the lender has dealt with it).
    s.c.asset_set_status(p, &s.r(STALL), &AssetStatus::Released);
}

#[test]
fn collateral_must_be_hers_and_active() {
    let s = Setup::new();
    let p = &s.partner;
    let no = Err(Ok(Error::CollateralUnavailable));
    s.register(STALL, KEMI);
    assert_eq!(
        s.c.try_loan_open(
            p,
            &s.r(LOAN),
            &s.r(FUNMI),
            &s.lender,
            &N,
            &0,
            &0,
            &N,
            &Some(s.r(STALL)),
            &150
        ),
        no
    );
    s.register(51, FUNMI);
    s.c.asset_set_status(p, &s.r(51), &AssetStatus::Stolen);
    assert_eq!(
        s.c.try_loan_open(
            p,
            &s.r(LOAN),
            &s.r(FUNMI),
            &s.lender,
            &N,
            &0,
            &0,
            &N,
            &Some(s.r(51)),
            &150
        ),
        no
    );
    // A refused open leaves nothing behind.
    assert_eq!(s.c.try_loan(&s.r(LOAN)), Err(Ok(Error::LoanNotFound)));
    assert_eq!(s.c.loans_of(&s.r(FUNMI)).len(), 0);
}

// ----- assets ----------------------------------------------------------------------

#[test]
fn assets_register_and_climb_levels() {
    let s = Setup::new();
    let p = &s.partner;
    s.register(STALL, FUNMI);
    assert_eq!(s.events(), 1);
    let a = s.c.asset(&s.r(STALL));
    assert_eq!(
        (a.owner.clone(), a.level, a.status, a.verification.clone()),
        (
            s.r(FUNMI),
            AssetLevel::Registered,
            AssetStatus::Active,
            s.r(200)
        )
    );
    assert_eq!(
        s.c.assets_of(&s.r(FUNMI)),
        soroban_sdk::vec![&s.env, s.r(STALL)]
    );
    s.c.asset_set_level(p, &s.r(STALL), &AssetLevel::EvidenceVerified, &s.r(201));
    s.c.asset_set_level(
        p,
        &s.r(STALL),
        &AssetLevel::IndependentlyVerified,
        &s.r(203),
    );
    assert_eq!(s.events(), 1);
    let a = s.c.asset(&s.r(STALL));
    assert_eq!(
        (a.level, a.verification),
        (AssetLevel::IndependentlyVerified, s.r(203))
    );
    // Same level, new evidence (a re-inspection): the hash moves, an event says so.
    s.c.asset_set_level(
        p,
        &s.r(STALL),
        &AssetLevel::IndependentlyVerified,
        &s.r(204),
    );
    assert_eq!(s.events(), 1);
    // Nothing new: no event.
    s.c.asset_set_level(
        p,
        &s.r(STALL),
        &AssetLevel::IndependentlyVerified,
        &s.r(204),
    );
    assert_eq!(s.events(), 0);
}

#[test]
fn asset_refusals() {
    let s = Setup::new();
    let p = &s.partner;
    assert_eq!(s.c.try_asset(&s.r(STALL)), Err(Ok(Error::AssetNotFound)));
    assert_eq!(
        s.c.try_asset_set_level(p, &s.r(STALL), &AssetLevel::EvidenceVerified, &s.r(1)),
        Err(Ok(Error::AssetNotFound))
    );
    assert_eq!(
        s.c.try_asset_set_status(p, &s.r(STALL), &AssetStatus::Lost),
        Err(Ok(Error::AssetNotFound))
    );
    s.register(STALL, FUNMI);
    assert_eq!(
        s.c.try_asset_register(p, &s.r(STALL), &s.r(KEMI), &s.r(1), &AssetLevel::Registered),
        Err(Ok(Error::AssetExists))
    );
    s.c.asset_set_level(p, &s.r(STALL), &AssetLevel::CommunityVerified, &s.r(202));
    assert_eq!(
        s.c.try_asset_set_level(p, &s.r(STALL), &AssetLevel::EvidenceVerified, &s.r(201)),
        Err(Ok(Error::LevelDown))
    );
    // Released is final.
    s.c.asset_set_status(p, &s.r(STALL), &AssetStatus::Released);
    assert_eq!(
        s.c.try_asset_set_status(p, &s.r(STALL), &AssetStatus::Active),
        Err(Ok(Error::InvalidTransition))
    );
    assert_eq!(
        s.c.try_asset_set_level(
            p,
            &s.r(STALL),
            &AssetLevel::IndependentlyVerified,
            &s.r(203)
        ),
        Err(Ok(Error::InvalidTransition))
    );
}

#[test]
fn asset_status_moves_and_back() {
    let s = Setup::new();
    let p = &s.partner;
    s.register(STALL, FUNMI);
    for to in [
        AssetStatus::UnderReview,
        AssetStatus::Active,
        AssetStatus::Stolen,
        AssetStatus::Active,
        AssetStatus::Damaged,
        AssetStatus::Lost,
    ] {
        s.c.asset_set_status(p, &s.r(STALL), &to);
        assert_eq!(s.events(), 1);
        assert_eq!(s.c.asset(&s.r(STALL)).status, to);
    }
    s.c.asset_set_status(p, &s.r(STALL), &AssetStatus::Lost);
    assert_eq!(s.events(), 0);
}

// ----- vouches ---------------------------------------------------------------------

#[test]
fn vouches_wait_for_her_next_loan() {
    let s = Setup::new();
    let p = &s.partner;
    s.c.vouch(p, &s.r(FUNMI), &s.r(AMAKA));
    assert_eq!(s.events(), 1);
    s.c.vouch(p, &s.r(FUNMI), &s.r(KEMI));
    assert_eq!(s.c.vouches_for(&s.r(FUNMI)).len(), 2);
    s.open(LOAN, FUNMI, None);
    let l = s.c.loan(&s.r(LOAN));
    assert_eq!(l.vouchers, soroban_sdk::vec![&s.env, s.r(AMAKA), s.r(KEMI)]);
    // Used up by this loan.
    assert_eq!(s.c.vouches_for(&s.r(FUNMI)).len(), 0);
    s.open(2, FUNMI, None);
    assert_eq!(s.c.loan(&s.r(2)).vouchers.len(), 0);
}

#[test]
fn a_default_flags_each_voucher() {
    let s = Setup::new();
    let p = &s.partner;
    s.c.vouch(p, &s.r(FUNMI), &s.r(AMAKA));
    s.c.vouch(p, &s.r(FUNMI), &s.r(KEMI));
    s.open(LOAN, FUNMI, None);
    s.c.loan_set_status(p, &s.r(LOAN), &LoanStatus::Default);
    assert_eq!(s.events(), 3); // LoanStatusChanged + 2 × VouchedLoanDefaulted
}

#[test]
fn vouch_refusals_and_revoke() {
    let s = Setup::new();
    let p = &s.partner;
    assert_eq!(
        s.c.try_vouch(p, &s.r(FUNMI), &s.r(FUNMI)),
        Err(Ok(Error::SelfVouch))
    );
    s.c.vouch(p, &s.r(FUNMI), &s.r(AMAKA));
    assert_eq!(
        s.c.try_vouch(p, &s.r(FUNMI), &s.r(AMAKA)),
        Err(Ok(Error::AlreadyVouched))
    );
    for i in 0..9u8 {
        s.c.vouch(p, &s.r(FUNMI), &s.r(100 + i));
    }
    assert_eq!(
        s.c.try_vouch(p, &s.r(FUNMI), &s.r(120)),
        Err(Ok(Error::TooManyVouches))
    );
    s.c.vouch_revoke(p, &s.r(FUNMI), &s.r(AMAKA));
    assert_eq!(s.events(), 1);
    assert!(!s.c.vouches_for(&s.r(FUNMI)).contains(s.r(AMAKA)));
    assert_eq!(
        s.c.try_vouch_revoke(p, &s.r(FUNMI), &s.r(AMAKA)),
        Err(Ok(Error::VouchNotFound))
    );
    assert_eq!(
        s.c.try_vouch_revoke(p, &s.r(KEMI), &s.r(AMAKA)),
        Err(Ok(Error::VouchNotFound))
    );
}

// ----- TTL ---------------------------------------------------------------------------

#[test]
fn writes_extend_ttl() {
    use soroban_sdk::testutils::storage::Persistent as _;
    let s = Setup::new();
    s.open(LOAN, FUNMI, None);
    let ttl = s.env.as_contract(&s.id, || {
        s.env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Loan(s.r(LOAN)))
    });
    assert!(ttl >= TTL_EXTEND_TO - 1);
}
