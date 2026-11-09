#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, IntoVal,
};

/// 1 unit with 7 decimals.
const U: i128 = 10_000_000;
const FEE_BPS: u32 = 150; // 1.5%
const DAY: u64 = 86_400;

struct Setup<'a> {
    env: Env,
    plus: PlusClient<'a>,
    admin: Address,
    partner: Address,
    usdc: Address,
    other: Address,
}

impl<'a> Setup<'a> {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1_000_000);

        let admin = Address::generate(&env);
        let partner = Address::generate(&env);
        let issuer = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(issuer.clone())
            .address();
        let other = env.register_stellar_asset_contract_v2(issuer).address();

        let id = env.register(
            Plus,
            (admin.clone(), partner.clone(), usdc.clone(), FEE_BPS),
        );
        let plus = PlusClient::new(&env, &id);
        Setup {
            env,
            plus,
            admin,
            partner,
            usdc,
            other,
        }
    }

    fn user(&self, usdc: i128) -> Address {
        let a = Address::generate(&self.env);
        if usdc > 0 {
            StellarAssetClient::new(&self.env, &self.usdc).mint(&a, &usdc);
        }
        a
    }

    fn bal(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.usdc).balance(who)
    }

    fn r(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n; 32])
    }

    fn fund_pool(&self, amount: i128) {
        StellarAssetClient::new(&self.env, &self.usdc).mint(&self.partner, &amount);
        self.plus.fund_pool(&self.usdc, &amount);
    }

    fn advance_now(&self, secs: u64) {
        let t = self.env.ledger().timestamp();
        self.env.ledger().set_timestamp(t + secs);
    }
}

// ---------------------------------------------------------------------------

#[test]
fn constructor_sets_config() {
    let s = Setup::new();
    let c = s.plus.config();
    assert_eq!(c.admin, s.admin);
    assert_eq!(c.partner, s.partner);
    assert_eq!(c.assets, vec![&s.env, s.usdc.clone()]);
    assert_eq!(c.advance_fee_bps, FEE_BPS);
}

#[test]
fn attest_updates_summary() {
    let s = Setup::new();
    let user = s.r(1);
    s.plus
        .attest(&user, &AttestKind::Received, &(100 * U), &s.r(9));
    s.advance_now(DAY);
    s.plus.attest(&user, &AttestKind::Saved, &(20 * U), &s.r(9));
    s.plus.attest(&user, &AttestKind::Paid, &(5 * U), &s.r(9));
    s.plus.attest(&user, &AttestKind::Received, &U, &s.r(9));

    let rec = s.plus.record_of(&user);
    assert_eq!(rec.total_received, 101 * U);
    assert_eq!(rec.total_saved, 20 * U);
    assert_eq!(rec.total_paid, 5 * U);
    assert_eq!(rec.total_group, 0);
    assert_eq!(rec.count, 4);
    assert_eq!(rec.first_ts, 1_000_000);
    assert_eq!(rec.last_ts, 1_000_000 + DAY);

    assert_eq!(
        s.plus.try_attest(&user, &AttestKind::Paid, &0, &s.r(9)),
        Err(Ok(Error::InvalidAmount))
    );
    // Partner signed the attestation.
    s.plus.attest(&user, &AttestKind::Paid, &1, &s.r(9));
    assert_eq!(s.env.auths()[0].0, s.partner);
}

#[test]
fn record_mode_group() {
    let s = Setup::new();
    let organizer = s.user(0);
    let alice = s.user(100 * U);
    let members = vec![
        &s.env,
        Party::Ref(s.r(1)),
        Party::Ref(s.r(2)),
        Party::Account(alice.clone()),
    ];
    // Record mode accepts Ref members.
    let gid = s
        .plus
        .group_create(&organizer, &members, &s.usdc, &(10 * U), &DAY, &false);

    // Contributions on-chain are refused in record mode.
    assert_eq!(
        s.plus.try_group_contribute(&alice, &gid),
        Err(Ok(Error::WrongMode))
    );
    // Payout is pooled-only.
    s.advance_now(DAY);
    assert_eq!(s.plus.try_group_payout(&gid), Err(Ok(Error::WrongMode)));

    // A stranger cannot record.
    let stranger = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.plus.address,
            fn_name: "group_record",
            args: (gid, s.r(1), 10 * U, s.r(9)).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s
        .plus
        .try_group_record(&gid, &s.r(1), &(10 * U), &s.r(9))
        .is_err());

    // The partner can.
    s.env.mock_all_auths();
    s.plus.group_record(&gid, &s.r(1), &(10 * U), &s.r(9));
    assert_eq!(s.env.auths()[0].0, s.partner);
    assert_eq!(s.plus.record_of(&s.r(1)).total_group, 10 * U);
    assert_eq!(s.plus.record_of(&s.r(1)).count, 1);

    // Non-member ref is refused.
    assert_eq!(
        s.plus.try_group_record(&gid, &s.r(7), &(10 * U), &s.r(9)),
        Err(Ok(Error::NotMember))
    );
}

#[test]
fn pooled_group_requires_accounts_and_allowed_asset() {
    let s = Setup::new();
    let org = s.user(0);
    let a = s.user(0);
    let with_ref = vec![&s.env, Party::Account(a.clone()), Party::Ref(s.r(1))];
    assert_eq!(
        s.plus
            .try_group_create(&org, &with_ref, &s.usdc, &U, &DAY, &true),
        Err(Ok(Error::WrongMode))
    );
    let accounts = vec![&s.env, Party::Account(a)];
    assert_eq!(
        s.plus
            .try_group_create(&org, &accounts, &s.other, &U, &DAY, &true),
        Err(Ok(Error::AssetNotAllowed))
    );
}

#[test]
fn pooled_group_flow() {
    let s = Setup::new();
    let org = s.user(0);
    let a = s.user(100 * U);
    let b = s.user(100 * U);
    let c = s.user(100 * U);
    let members = vec![
        &s.env,
        Party::Account(a.clone()),
        Party::Account(b.clone()),
        Party::Account(c.clone()),
    ];
    let gid = s
        .plus
        .group_create(&org, &members, &s.usdc, &(10 * U), &DAY, &true);

    // Round 1: everyone contributes; duplicate refused; non-member refused.
    s.plus.group_contribute(&a, &gid);
    assert_eq!(
        s.plus.try_group_contribute(&a, &gid),
        Err(Ok(Error::AlreadyContributed))
    );
    assert_eq!(
        s.plus.try_group_contribute(&org, &gid),
        Err(Ok(Error::NotMember))
    );
    s.plus.group_contribute(&b, &gid);
    s.plus.group_contribute(&c, &gid);
    assert_eq!(s.plus.group(&gid).pot, 30 * U);
    assert_eq!(s.bal(&s.plus.address), 30 * U);

    // Not due yet.
    assert_eq!(s.plus.try_group_payout(&gid), Err(Ok(Error::NotDue)));
    s.advance_now(DAY);
    s.plus.group_payout(&gid);
    assert_eq!(s.bal(&a), 90 * U + 30 * U);
    let g = s.plus.group(&gid);
    assert_eq!(g.turn, 1);
    assert_eq!(g.pot, 0);
    assert_eq!(g.contributed, vec![&s.env, false, false, false]);
    assert_eq!(g.next_due, 1_000_000 + 2 * DAY);

    // Round 2: b has an open advance which is repaid first.
    s.fund_pool(100 * U);
    s.plus
        .set_credit_limit(&Party::Account(b.clone()), &(20 * U));
    s.plus.request_advance(&b, &s.usdc, &(20 * U)); // owed 20.3
    assert_eq!(s.bal(&b), 90 * U + 20 * U);
    let b_before = s.bal(&b);

    s.plus.group_contribute(&a, &gid);
    s.plus.group_contribute(&b, &gid);
    s.plus.group_contribute(&c, &gid);
    let b_before = b_before - 10 * U;
    s.advance_now(DAY);
    s.plus.group_payout(&gid);

    let owed = 20 * U + 20 * U * 150 / 10_000; // 20.3
    assert_eq!(s.bal(&b), b_before + 30 * U - owed);
    assert_eq!(s.plus.advance_of(&Party::Account(b.clone())), None);
    assert_eq!(s.plus.pool_balance(&s.usdc), 100 * U - 20 * U + owed);
    assert_eq!(s.plus.group(&gid).turn, 2);

    // Round 3 goes to c, then wraps back to a.
    s.advance_now(DAY);
    s.plus.group_payout(&gid); // empty pot is fine
    assert_eq!(s.plus.group(&gid).turn, 0);
}

#[test]
fn payout_partially_reduces_large_advance() {
    let s = Setup::new();
    let org = s.user(0);
    let a = s.user(100 * U);
    let gid = s.plus.group_create(
        &org,
        &vec![&s.env, Party::Account(a.clone())],
        &s.usdc,
        &(5 * U),
        &DAY,
        &true,
    );
    s.fund_pool(100 * U);
    s.plus
        .set_credit_limit(&Party::Account(a.clone()), &(50 * U));
    s.plus.request_advance(&a, &s.usdc, &(40 * U));
    let owed = 40 * U + 40 * U * 150 / 10_000;
    s.plus.group_contribute(&a, &gid);
    let before = s.bal(&a);
    s.advance_now(DAY);
    s.plus.group_payout(&gid);
    assert_eq!(s.bal(&a), before); // whole pot went to the advance
    assert_eq!(
        s.plus.advance_of(&Party::Account(a)).unwrap().owed,
        owed - 5 * U
    );
}

#[test]
fn scheduled_pot_release() {
    let s = Setup::new();
    let parent = s.user(100 * U);
    let kid = s.user(0);
    let pid = s
        .plus
        .pot_create(&parent, &kid, &s.usdc, &(30 * U), &(7 * DAY));
    s.plus.pot_fund(&parent, &pid, &(70 * U));
    assert_eq!(s.bal(&s.plus.address), 70 * U);

    assert_eq!(s.plus.try_pot_release(&pid), Err(Ok(Error::NotDue)));
    s.advance_now(7 * DAY);
    s.plus.pot_release(&pid);
    assert_eq!(s.bal(&kid), 30 * U);
    assert_eq!(s.plus.try_pot_release(&pid), Err(Ok(Error::NotDue)));

    s.advance_now(7 * DAY);
    s.plus.pot_release(&pid);
    s.advance_now(7 * DAY);
    s.plus.pot_release(&pid); // only 10 left
    assert_eq!(s.bal(&kid), 70 * U);
    let p = s.plus.pot(&pid);
    assert_eq!(p.balance, 0);
    assert_eq!(p.next_release, 1_000_000 + 28 * DAY);
    s.advance_now(7 * DAY);
    assert_eq!(
        s.plus.try_pot_release(&pid),
        Err(Ok(Error::InsufficientBalance))
    );
}

#[test]
fn manual_pot_send_and_cancel() {
    let s = Setup::new();
    let sender = s.user(100 * U);
    let to = s.user(0);
    let pid = s.plus.pot_create(&sender, &to, &s.usdc, &(10 * U), &0);
    s.plus.pot_fund(&sender, &pid, &(50 * U));

    // Manual-only pot cannot be released on a schedule.
    assert_eq!(s.plus.try_pot_release(&pid), Err(Ok(Error::WrongMode)));

    s.plus.pot_send(&sender, &pid, &(15 * U));
    assert_eq!(s.bal(&to), 15 * U);
    assert_eq!(s.plus.pot(&pid).balance, 35 * U);
    assert_eq!(
        s.plus.try_pot_send(&sender, &pid, &(36 * U)),
        Err(Ok(Error::InsufficientBalance))
    );

    // Only the sender can move funds.
    let other = s.user(10 * U);
    assert_eq!(
        s.plus.try_pot_send(&other, &pid, &U),
        Err(Ok(Error::NotAuthorized))
    );
    assert_eq!(
        s.plus.try_pot_cancel(&other, &pid),
        Err(Ok(Error::NotAuthorized))
    );

    s.plus.pot_cancel(&sender, &pid);
    assert_eq!(s.bal(&sender), 50 * U + 35 * U);
    assert_eq!(s.bal(&s.plus.address), 0);
    assert_eq!(s.plus.try_pot(&pid), Err(Ok(Error::NotFound)));
}

#[test]
fn request_advance_rules() {
    let s = Setup::new();
    let user = s.user(0);
    let party = Party::Account(user.clone());
    s.fund_pool(150 * U);
    s.plus.set_credit_limit(&party, &(100 * U));
    assert_eq!(s.plus.limit_of(&party), 100 * U);

    assert_eq!(
        s.plus.try_request_advance(&user, &s.usdc, &(101 * U)),
        Err(Ok(Error::OverLimit))
    );

    s.plus.request_advance(&user, &s.usdc, &(100 * U));
    let adv = s.plus.advance_of(&party).unwrap();
    assert_eq!(adv.principal, 100 * U);
    assert_eq!(adv.fee, 15 * U / 10); // 1.5%
    assert_eq!(adv.owed, 1015 * U / 10);
    assert_eq!(adv.asset, Some(s.usdc.clone()));
    assert_eq!(s.bal(&user), 100 * U);
    assert_eq!(s.plus.pool_balance(&s.usdc), 50 * U);

    assert_eq!(
        s.plus.try_request_advance(&user, &s.usdc, &U),
        Err(Ok(Error::AdvanceOpen))
    );

    // Pool too small for a second borrower.
    let other = s.user(0);
    s.plus
        .set_credit_limit(&Party::Account(other.clone()), &(100 * U));
    assert_eq!(
        s.plus.try_request_advance(&other, &s.usdc, &(60 * U)),
        Err(Ok(Error::InsufficientPool))
    );
    // No limit set means limit 0.
    let nobody = s.user(0);
    assert_eq!(
        s.plus.try_request_advance(&nobody, &s.usdc, &U),
        Err(Ok(Error::OverLimit))
    );
}

#[test]
fn repay_closes_advance() {
    let s = Setup::new();
    let user = s.user(10 * U);
    let party = Party::Account(user.clone());
    s.fund_pool(100 * U);
    s.plus.set_credit_limit(&party, &(100 * U));
    assert_eq!(s.plus.try_repay(&user, &U), Err(Ok(Error::NoAdvance)));
    s.plus.request_advance(&user, &s.usdc, &(100 * U)); // owed 101.5

    s.plus.repay(&user, &(50 * U));
    assert_eq!(s.plus.advance_of(&party).unwrap().owed, 515 * U / 10);
    // Overpaying only takes what's owed.
    s.plus.repay(&user, &(100 * U));
    assert_eq!(s.plus.advance_of(&party), None);
    assert_eq!(s.bal(&user), 110 * U - 1015 * U / 10);
    assert_eq!(s.plus.pool_balance(&s.usdc), 1015 * U / 10);
    assert_eq!(s.bal(&s.plus.address), 1015 * U / 10);
}

#[test]
fn record_advance_for_ref() {
    let s = Setup::new();
    let who = s.r(3);
    let party = Party::Ref(who.clone());
    s.plus.set_credit_limit(&party, &(50 * U));

    assert_eq!(
        s.plus.try_record_advance(&who, &(51 * U), &U),
        Err(Ok(Error::OverLimit))
    );
    assert_eq!(
        s.plus.try_record_repayment(&who, &U, &s.r(9)),
        Err(Ok(Error::NoAdvance))
    );
    s.plus.record_advance(&who, &(50 * U), &U);
    let adv = s.plus.advance_of(&party).unwrap();
    assert_eq!(adv.owed, 51 * U);
    assert_eq!(adv.asset, None);
    assert_eq!(
        s.plus.try_record_advance(&who, &U, &0),
        Err(Ok(Error::AdvanceOpen))
    );

    s.plus.record_repayment(&who, &(20 * U), &s.r(9));
    assert_eq!(s.plus.advance_of(&party).unwrap().owed, 31 * U);
    s.plus.record_repayment(&who, &(31 * U), &s.r(9));
    assert_eq!(s.plus.advance_of(&party), None);
    // No tokens moved for off-chain borrowers.
    assert_eq!(s.bal(&s.plus.address), 0);
}

#[test]
fn paused_contract_refuses_state_changes() {
    let s = Setup::new();
    let user = s.user(10 * U);
    s.plus.pause();
    assert_eq!(s.env.auths()[0].0, s.admin);
    assert!(s.plus.paused());

    let r = s.r(1);
    let members = vec![&s.env, Party::Account(user.clone())];
    assert_eq!(
        s.plus.try_attest(&r, &AttestKind::Paid, &U, &r),
        Err(Ok(Error::Paused))
    );
    assert_eq!(s.plus.try_add_asset(&s.other), Err(Ok(Error::Paused)));
    assert_eq!(
        s.plus
            .try_group_create(&user, &members, &s.usdc, &U, &DAY, &true),
        Err(Ok(Error::Paused))
    );
    assert_eq!(
        s.plus.try_pot_create(&user, &user, &s.usdc, &U, &0),
        Err(Ok(Error::Paused))
    );
    assert_eq!(s.plus.try_fund_pool(&s.usdc, &U), Err(Ok(Error::Paused)));
    assert_eq!(
        s.plus.try_set_credit_limit(&Party::Ref(r.clone()), &U),
        Err(Ok(Error::Paused))
    );
    assert_eq!(
        s.plus.try_request_advance(&user, &s.usdc, &U),
        Err(Ok(Error::Paused))
    );
    assert_eq!(s.plus.try_repay(&user, &U), Err(Ok(Error::Paused)));
    assert_eq!(
        s.plus.try_record_advance(&r, &U, &0),
        Err(Ok(Error::Paused))
    );
    assert_eq!(s.plus.try_pause(), Err(Ok(Error::Paused)));
    // Views still work.
    assert_eq!(s.plus.pool_balance(&s.usdc), 0);

    s.plus.unpause();
    assert!(!s.plus.paused());
    s.plus.attest(&r, &AttestKind::Paid, &U, &r);
}

#[test]
fn unknown_asset_refused_until_added() {
    let s = Setup::new();
    let user = s.user(0);
    assert_eq!(
        s.plus.try_pot_create(&user, &user, &s.other, &U, &0),
        Err(Ok(Error::AssetNotAllowed))
    );
    assert_eq!(
        s.plus.try_fund_pool(&s.other, &U),
        Err(Ok(Error::AssetNotAllowed))
    );
    assert_eq!(
        s.plus.try_request_advance(&user, &s.other, &U),
        Err(Ok(Error::AssetNotAllowed))
    );

    s.plus.add_asset(&s.other);
    assert_eq!(s.env.auths()[0].0, s.admin);
    assert!(s.plus.config().assets.contains(&s.other));
    s.plus.pot_create(&user, &user, &s.other, &U, &0);
}

#[test]
fn only_admin_can_pause() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &s.plus.address,
            fn_name: "pause",
            args: ().into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.plus.try_pause().is_err());
    assert!(!s.plus.paused());
}

#[test]
fn group_create_rejects_duplicate_members() {
    let s = Setup::new();
    let org = s.user(0);
    let a = s.user(0);
    let dup_accounts = vec![
        &s.env,
        Party::Account(a.clone()),
        Party::Account(s.user(0)),
        Party::Account(a),
    ];
    assert_eq!(
        s.plus
            .try_group_create(&org, &dup_accounts, &s.usdc, &U, &DAY, &true),
        Err(Ok(Error::DuplicateMember))
    );
    let dup_refs = vec![&s.env, Party::Ref(s.r(1)), Party::Ref(s.r(1))];
    assert_eq!(
        s.plus
            .try_group_create(&org, &dup_refs, &s.usdc, &U, &DAY, &false),
        Err(Ok(Error::DuplicateMember))
    );
    // Distinct refs are accepted.
    let ok = vec![&s.env, Party::Ref(s.r(1)), Party::Ref(s.r(2))];
    s.plus.group_create(&org, &ok, &s.usdc, &U, &DAY, &false);
}
