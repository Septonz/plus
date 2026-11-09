#![no_std]
//! Plus: one market-agnostic contract for group pots, family pots, the advance
//! pool and partner attestations.
//!
//! The contract never holds everyday user balances. It only holds:
//! - group pots (pooled groups),
//! - family pots,
//! - the advance pool (per asset).
//!
//! People who are not on Stellar (for example Indian users) appear only as
//! 32-byte hashes (`Party::Ref`). No personal data is stored on-chain.
//! Amounts are `i128` with 7 decimals.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env, MuxedAddress, Symbol, Vec,
};
use stellar_access::access_control::{self, AccessControl};
use stellar_contract_utils::pausable;

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 120 * DAY_IN_LEDGERS;

const BPS_DENOMINATOR: i128 = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A participant: either a Stellar account or a 32-byte off-chain reference hash.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Party {
    Account(Address),
    Ref(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AttestKind {
    Received = 0,
    Saved = 1,
    Paid = 2,
}

/// Public view of the configuration. `admin` is read from OpenZeppelin access control.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub partner: Address,
    pub assets: Vec<Address>,
    pub advance_fee_bps: u32,
}

/// Stored configuration (the admin lives in OpenZeppelin access-control storage,
/// so admin transfers through `transfer_admin_role` stay the single source of truth).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settings {
    pub partner: Address,
    pub assets: Vec<Address>,
    pub advance_fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RecordSummary {
    pub total_received: i128,
    pub total_saved: i128,
    pub total_paid: i128,
    pub total_group: i128,
    pub count: u32,
    pub first_ts: u64,
    pub last_ts: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Group {
    pub organizer: Address,
    pub members: Vec<Party>,
    pub asset: Address,
    pub amount: i128,
    pub period_secs: u64,
    pub next_due: u64,
    pub turn: u32,
    pub pot: i128,
    pub pooled: bool,
    pub contributed: Vec<bool>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pot {
    pub sender: Address,
    pub payout_to: Address,
    pub asset: Address,
    pub balance: i128,
    pub per_period: i128,
    /// 0 means manual release only.
    pub period_secs: u64,
    pub next_release: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Advance {
    pub principal: i128,
    pub fee: i128,
    pub owed: i128,
    /// Set only for `Party::Account` advances paid out of the on-chain pool.
    pub asset: Option<Address>,
    pub opened_ts: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    // instance
    Settings,
    NextGroupId,
    NextPotId,
    // persistent
    Record(BytesN<32>),
    Group(u32),
    Pot(u32),
    Advance(Party),
    Limit(Party),
    Pool(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
    Paused = 2,
    InvalidAmount = 3,
    AssetNotAllowed = 4,
    NotFound = 5,
    NotMember = 6,
    WrongMode = 7,
    AlreadyContributed = 8,
    NotDue = 9,
    OverLimit = 10,
    AdvanceOpen = 11,
    NoAdvance = 12,
    InsufficientPool = 13,
    InsufficientBalance = 14,
    DuplicateMember = 15,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
pub struct AssetAdded {
    #[topic]
    pub asset: Address,
}

#[contractevent]
pub struct Attested {
    #[topic]
    pub user_ref: BytesN<32>,
    pub kind: AttestKind,
    pub amount: i128,
    pub payment_ref: BytesN<32>,
}

#[contractevent]
pub struct GroupCreated {
    #[topic]
    pub group_id: u32,
    pub organizer: Address,
    pub pooled: bool,
}

#[contractevent]
pub struct Contributed {
    #[topic]
    pub group_id: u32,
    #[topic]
    pub user: Address,
    pub amount: i128,
}

#[contractevent]
pub struct ContributionRecorded {
    #[topic]
    pub group_id: u32,
    #[topic]
    pub member_ref: BytesN<32>,
    pub amount: i128,
    pub payment_ref: BytesN<32>,
}

#[contractevent]
pub struct PaidOut {
    #[topic]
    pub group_id: u32,
    #[topic]
    pub to: Address,
    pub amount: i128,
    pub advance_repaid: i128,
    pub turn: u32,
}

#[contractevent]
pub struct PotCreated {
    #[topic]
    pub pot_id: u32,
    pub sender: Address,
    pub payout_to: Address,
}

#[contractevent]
pub struct PotFunded {
    #[topic]
    pub pot_id: u32,
    pub amount: i128,
    pub balance: i128,
}

#[contractevent]
pub struct PotReleased {
    #[topic]
    pub pot_id: u32,
    pub to: Address,
    pub amount: i128,
    pub balance: i128,
}

#[contractevent]
pub struct PotCancelled {
    #[topic]
    pub pot_id: u32,
    pub refunded: i128,
}

#[contractevent]
pub struct LimitSet {
    #[topic]
    pub borrower: Party,
    pub limit: i128,
}

#[contractevent]
pub struct PoolFunded {
    #[topic]
    pub asset: Address,
    pub amount: i128,
    pub balance: i128,
}

#[contractevent]
pub struct AdvanceIssued {
    #[topic]
    pub user: Address,
    pub asset: Address,
    pub principal: i128,
    pub fee: i128,
    pub owed: i128,
}

#[contractevent]
pub struct Repaid {
    #[topic]
    pub user: Address,
    pub amount: i128,
    pub owed: i128,
}

#[contractevent]
pub struct AdvanceRecorded {
    #[topic]
    pub user_ref: BytesN<32>,
    pub principal: i128,
    pub fee: i128,
    pub owed: i128,
}

#[contractevent]
pub struct RepaymentRecorded {
    #[topic]
    pub user_ref: BytesN<32>,
    pub amount: i128,
    pub owed: i128,
    pub payment_ref: BytesN<32>,
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

fn remove(env: &Env, key: &DataKey) {
    env.storage().persistent().remove(key);
}

fn get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey) -> Option<V> {
    env.storage().persistent().get(key)
}

fn settings(env: &Env) -> Settings {
    // Always set by the constructor.
    env.storage().instance().get(&DataKey::Settings).unwrap()
}

/// Every state-changing entry point (except `unpause`) starts here.
fn when_active(env: &Env) -> Result<(), Error> {
    if pausable::paused(env) {
        return Err(Error::Paused);
    }
    bump_instance(env);
    Ok(())
}

fn require_partner(env: &Env) -> Address {
    let partner = settings(env).partner;
    partner.require_auth();
    partner
}

fn require_asset(env: &Env, asset: &Address) -> Result<(), Error> {
    if settings(env).assets.contains(asset) {
        Ok(())
    } else {
        Err(Error::AssetNotAllowed)
    }
}

fn positive(amount: i128) -> Result<(), Error> {
    if amount > 0 {
        Ok(())
    } else {
        Err(Error::InvalidAmount)
    }
}

fn add(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_add(b).ok_or(Error::InvalidAmount)
}

fn sub(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_sub(b).ok_or(Error::InvalidAmount)
}

fn add_secs(a: u64, b: u64) -> Result<u64, Error> {
    a.checked_add(b).ok_or(Error::InvalidAmount)
}

fn transfer(env: &Env, asset: &Address, from: &Address, to: &Address, amount: i128) {
    if amount == 0 {
        return;
    }
    let to: MuxedAddress = to.into();
    token::TokenClient::new(env, asset).transfer(from, &to, &amount);
}

fn next_id(env: &Env, key: &DataKey) -> Result<u32, Error> {
    let id: u32 = env.storage().instance().get(key).unwrap_or(0);
    let next = id.checked_add(1).ok_or(Error::InvalidAmount)?;
    env.storage().instance().set(key, &next);
    Ok(id)
}

fn pool_of(env: &Env, asset: &Address) -> i128 {
    get(env, &DataKey::Pool(asset.clone())).unwrap_or(0)
}

fn set_pool(env: &Env, asset: &Address, balance: i128) {
    put(env, &DataKey::Pool(asset.clone()), &balance);
}

fn limit(env: &Env, party: &Party) -> i128 {
    get(env, &DataKey::Limit(party.clone())).unwrap_or(0)
}

fn record(env: &Env, user_ref: &BytesN<32>) -> RecordSummary {
    get(env, &DataKey::Record(user_ref.clone())).unwrap_or_default()
}

fn touch_record(env: &Env, summary: &mut RecordSummary) -> Result<(), Error> {
    let now = env.ledger().timestamp();
    summary.count = summary.count.checked_add(1).ok_or(Error::InvalidAmount)?;
    if summary.first_ts == 0 {
        summary.first_ts = now;
    }
    summary.last_ts = now;
    Ok(())
}

fn load_group(env: &Env, group_id: u32) -> Result<Group, Error> {
    get(env, &DataKey::Group(group_id)).ok_or(Error::NotFound)
}

fn load_pot(env: &Env, pot_id: u32) -> Result<Pot, Error> {
    get(env, &DataKey::Pot(pot_id)).ok_or(Error::NotFound)
}

fn load_sender_pot(env: &Env, sender: &Address, pot_id: u32) -> Result<Pot, Error> {
    let pot = load_pot(env, pot_id)?;
    if pot.sender != *sender {
        return Err(Error::NotAuthorized);
    }
    Ok(pot)
}

/// Apply up to `amount` to an open advance. Returns the amount actually applied
/// and the remaining amount owed. Closes the advance when it reaches zero.
fn apply_repayment(
    env: &Env,
    party: &Party,
    adv: &mut Advance,
    amount: i128,
) -> Result<i128, Error> {
    let applied = amount.min(adv.owed);
    adv.owed = sub(adv.owed, applied)?;
    let key = DataKey::Advance(party.clone());
    if adv.owed == 0 {
        remove(env, &key);
    } else {
        put(env, &key, adv);
    }
    Ok(applied)
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct Plus;

#[contractimpl]
impl Plus {
    pub fn __constructor(
        env: Env,
        admin: Address,
        partner: Address,
        usdc: Address,
        advance_fee_bps: u32,
    ) {
        if advance_fee_bps as i128 > BPS_DENOMINATOR {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        access_control::set_admin(&env, &admin);
        let mut assets = Vec::new(&env);
        assets.push_back(usdc.clone());
        env.storage().instance().set(
            &DataKey::Settings,
            &Settings {
                partner,
                assets,
                advance_fee_bps,
            },
        );
        bump_instance(&env);
        AssetAdded { asset: usdc }.publish(&env);
    }

    // ----- admin -----------------------------------------------------------

    pub fn add_asset(env: Env, asset: Address) -> Result<(), Error> {
        when_active(&env)?;
        access_control::enforce_admin_auth(&env);
        let mut s = settings(&env);
        if !s.assets.contains(&asset) {
            s.assets.push_back(asset.clone());
            env.storage().instance().set(&DataKey::Settings, &s);
            AssetAdded { asset }.publish(&env);
        }
        Ok(())
    }

    pub fn pause(env: Env) -> Result<(), Error> {
        when_active(&env)?;
        access_control::enforce_admin_auth(&env);
        pausable::pause(&env);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        access_control::enforce_admin_auth(&env);
        if pausable::paused(&env) {
            pausable::unpause(&env);
        }
        bump_instance(&env);
        Ok(())
    }

    pub fn paused(env: Env) -> bool {
        pausable::paused(&env)
    }

    // ----- attestations ----------------------------------------------------

    pub fn attest(
        env: Env,
        user_ref: BytesN<32>,
        kind: AttestKind,
        amount: i128,
        payment_ref: BytesN<32>,
    ) -> Result<(), Error> {
        when_active(&env)?;
        require_partner(&env);
        positive(amount)?;

        let mut summary = record(&env, &user_ref);
        match kind {
            AttestKind::Received => summary.total_received = add(summary.total_received, amount)?,
            AttestKind::Saved => summary.total_saved = add(summary.total_saved, amount)?,
            AttestKind::Paid => summary.total_paid = add(summary.total_paid, amount)?,
        }
        touch_record(&env, &mut summary)?;
        put(&env, &DataKey::Record(user_ref.clone()), &summary);

        Attested {
            user_ref,
            kind,
            amount,
            payment_ref,
        }
        .publish(&env);
        Ok(())
    }

    // ----- groups ----------------------------------------------------------

    pub fn group_create(
        env: Env,
        organizer: Address,
        members: Vec<Party>,
        asset: Address,
        amount: i128,
        period_secs: u64,
        pooled: bool,
    ) -> Result<u32, Error> {
        when_active(&env)?;
        organizer.require_auth();
        positive(amount)?;
        if members.is_empty() || period_secs == 0 {
            return Err(Error::InvalidAmount);
        }
        for (i, m) in members.iter().enumerate() {
            if members.first_index_of(m) != Some(i as u32) {
                return Err(Error::DuplicateMember);
            }
        }
        if pooled {
            require_asset(&env, &asset)?;
            if members.iter().any(|m| !matches!(m, Party::Account(_))) {
                return Err(Error::WrongMode);
            }
        }

        let mut contributed = Vec::new(&env);
        for _ in 0..members.len() {
            contributed.push_back(false);
        }
        let next_due = add_secs(env.ledger().timestamp(), period_secs)?;
        let id = next_id(&env, &DataKey::NextGroupId)?;
        let group = Group {
            organizer: organizer.clone(),
            members,
            asset,
            amount,
            period_secs,
            next_due,
            turn: 0,
            pot: 0,
            pooled,
            contributed,
        };
        put(&env, &DataKey::Group(id), &group);

        GroupCreated {
            group_id: id,
            organizer,
            pooled,
        }
        .publish(&env);
        Ok(id)
    }

    pub fn group_contribute(env: Env, user: Address, group_id: u32) -> Result<(), Error> {
        when_active(&env)?;
        user.require_auth();
        let mut g = load_group(&env, group_id)?;
        if !g.pooled {
            return Err(Error::WrongMode);
        }
        let idx = g
            .members
            .first_index_of(Party::Account(user.clone()))
            .ok_or(Error::NotMember)?;
        if g.contributed.get(idx).unwrap_or(false) {
            return Err(Error::AlreadyContributed);
        }
        g.contributed.set(idx, true);
        g.pot = add(g.pot, g.amount)?;
        put(&env, &DataKey::Group(group_id), &g);

        transfer(
            &env,
            &g.asset,
            &user,
            &env.current_contract_address(),
            g.amount,
        );
        Contributed {
            group_id,
            user,
            amount: g.amount,
        }
        .publish(&env);
        Ok(())
    }

    pub fn group_record(
        env: Env,
        group_id: u32,
        member_ref: BytesN<32>,
        amount: i128,
        payment_ref: BytesN<32>,
    ) -> Result<(), Error> {
        when_active(&env)?;
        require_partner(&env);
        positive(amount)?;
        let g = load_group(&env, group_id)?;
        if g.pooled {
            return Err(Error::WrongMode);
        }
        if !g.members.contains(Party::Ref(member_ref.clone())) {
            return Err(Error::NotMember);
        }

        let mut summary = record(&env, &member_ref);
        summary.total_group = add(summary.total_group, amount)?;
        touch_record(&env, &mut summary)?;
        put(&env, &DataKey::Record(member_ref.clone()), &summary);

        ContributionRecorded {
            group_id,
            member_ref,
            amount,
            payment_ref,
        }
        .publish(&env);
        Ok(())
    }

    pub fn group_payout(env: Env, group_id: u32) -> Result<(), Error> {
        when_active(&env)?;
        let mut g = load_group(&env, group_id)?;
        if !g.pooled {
            return Err(Error::WrongMode);
        }
        if env.ledger().timestamp() < g.next_due {
            return Err(Error::NotDue);
        }
        let len = g.members.len();
        let paid_turn = g.turn;
        let recipient = match g.members.get(paid_turn) {
            Some(Party::Account(a)) => a,
            _ => return Err(Error::WrongMode),
        };

        // Repay the recipient's open advance in the same asset first.
        let party = Party::Account(recipient.clone());
        let mut repaid = 0i128;
        if let Some(mut adv) = get::<Advance>(&env, &DataKey::Advance(party.clone())) {
            if adv.asset.as_ref() == Some(&g.asset) && g.pot > 0 {
                repaid = apply_repayment(&env, &party, &mut adv, g.pot)?;
                set_pool(&env, &g.asset, add(pool_of(&env, &g.asset), repaid)?);
                Repaid {
                    user: recipient.clone(),
                    amount: repaid,
                    owed: adv.owed,
                }
                .publish(&env);
            }
        }
        let payout = sub(g.pot, repaid)?;

        g.pot = 0;
        for i in 0..len {
            g.contributed.set(i, false);
        }
        g.turn = (g.turn + 1) % len;
        g.next_due = add_secs(g.next_due, g.period_secs)?;
        put(&env, &DataKey::Group(group_id), &g);

        transfer(
            &env,
            &g.asset,
            &env.current_contract_address(),
            &recipient,
            payout,
        );
        PaidOut {
            group_id,
            to: recipient,
            amount: payout,
            advance_repaid: repaid,
            turn: paid_turn,
        }
        .publish(&env);
        Ok(())
    }

    // ----- pots ------------------------------------------------------------

    pub fn pot_create(
        env: Env,
        sender: Address,
        payout_to: Address,
        asset: Address,
        per_period: i128,
        period_secs: u64,
    ) -> Result<u32, Error> {
        when_active(&env)?;
        sender.require_auth();
        require_asset(&env, &asset)?;
        positive(per_period)?;
        let next_release = if period_secs == 0 {
            0
        } else {
            add_secs(env.ledger().timestamp(), period_secs)?
        };
        let id = next_id(&env, &DataKey::NextPotId)?;
        let pot = Pot {
            sender: sender.clone(),
            payout_to: payout_to.clone(),
            asset,
            balance: 0,
            per_period,
            period_secs,
            next_release,
        };
        put(&env, &DataKey::Pot(id), &pot);

        PotCreated {
            pot_id: id,
            sender,
            payout_to,
        }
        .publish(&env);
        Ok(id)
    }

    pub fn pot_fund(env: Env, sender: Address, pot_id: u32, amount: i128) -> Result<(), Error> {
        when_active(&env)?;
        sender.require_auth();
        positive(amount)?;
        let mut pot = load_sender_pot(&env, &sender, pot_id)?;
        pot.balance = add(pot.balance, amount)?;
        put(&env, &DataKey::Pot(pot_id), &pot);

        transfer(
            &env,
            &pot.asset,
            &sender,
            &env.current_contract_address(),
            amount,
        );
        PotFunded {
            pot_id,
            amount,
            balance: pot.balance,
        }
        .publish(&env);
        Ok(())
    }

    pub fn pot_release(env: Env, pot_id: u32) -> Result<(), Error> {
        when_active(&env)?;
        let mut pot = load_pot(&env, pot_id)?;
        if pot.period_secs == 0 {
            return Err(Error::WrongMode);
        }
        if env.ledger().timestamp() < pot.next_release {
            return Err(Error::NotDue);
        }
        if pot.balance == 0 {
            return Err(Error::InsufficientBalance);
        }
        let amount = pot.per_period.min(pot.balance);
        pot.balance = sub(pot.balance, amount)?;
        pot.next_release = add_secs(pot.next_release, pot.period_secs)?;
        put(&env, &DataKey::Pot(pot_id), &pot);

        transfer(
            &env,
            &pot.asset,
            &env.current_contract_address(),
            &pot.payout_to,
            amount,
        );
        PotReleased {
            pot_id,
            to: pot.payout_to,
            amount,
            balance: pot.balance,
        }
        .publish(&env);
        Ok(())
    }

    pub fn pot_send(env: Env, sender: Address, pot_id: u32, amount: i128) -> Result<(), Error> {
        when_active(&env)?;
        sender.require_auth();
        positive(amount)?;
        let mut pot = load_sender_pot(&env, &sender, pot_id)?;
        if amount > pot.balance {
            return Err(Error::InsufficientBalance);
        }
        pot.balance = sub(pot.balance, amount)?;
        put(&env, &DataKey::Pot(pot_id), &pot);

        transfer(
            &env,
            &pot.asset,
            &env.current_contract_address(),
            &pot.payout_to,
            amount,
        );
        PotReleased {
            pot_id,
            to: pot.payout_to,
            amount,
            balance: pot.balance,
        }
        .publish(&env);
        Ok(())
    }

    pub fn pot_cancel(env: Env, sender: Address, pot_id: u32) -> Result<(), Error> {
        when_active(&env)?;
        sender.require_auth();
        let pot = load_sender_pot(&env, &sender, pot_id)?;
        remove(&env, &DataKey::Pot(pot_id));

        transfer(
            &env,
            &pot.asset,
            &env.current_contract_address(),
            &sender,
            pot.balance,
        );
        PotCancelled {
            pot_id,
            refunded: pot.balance,
        }
        .publish(&env);
        Ok(())
    }

    // ----- advances --------------------------------------------------------

    pub fn set_credit_limit(env: Env, borrower: Party, limit: i128) -> Result<(), Error> {
        when_active(&env)?;
        require_partner(&env);
        if limit < 0 {
            return Err(Error::InvalidAmount);
        }
        put(&env, &DataKey::Limit(borrower.clone()), &limit);
        LimitSet { borrower, limit }.publish(&env);
        Ok(())
    }

    pub fn fund_pool(env: Env, asset: Address, amount: i128) -> Result<(), Error> {
        when_active(&env)?;
        let partner = require_partner(&env);
        require_asset(&env, &asset)?;
        positive(amount)?;
        let balance = add(pool_of(&env, &asset), amount)?;
        set_pool(&env, &asset, balance);

        transfer(
            &env,
            &asset,
            &partner,
            &env.current_contract_address(),
            amount,
        );
        PoolFunded {
            asset,
            amount,
            balance,
        }
        .publish(&env);
        Ok(())
    }

    pub fn request_advance(
        env: Env,
        user: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), Error> {
        when_active(&env)?;
        user.require_auth();
        require_asset(&env, &asset)?;
        positive(amount)?;
        let party = Party::Account(user.clone());
        if amount > limit(&env, &party) {
            return Err(Error::OverLimit);
        }
        let key = DataKey::Advance(party);
        if env.storage().persistent().has(&key) {
            return Err(Error::AdvanceOpen);
        }
        let pool = pool_of(&env, &asset);
        if amount > pool {
            return Err(Error::InsufficientPool);
        }

        let bps = settings(&env).advance_fee_bps as i128;
        let fee = amount.checked_mul(bps).ok_or(Error::InvalidAmount)? / BPS_DENOMINATOR;
        let owed = add(amount, fee)?;
        let adv = Advance {
            principal: amount,
            fee,
            owed,
            asset: Some(asset.clone()),
            opened_ts: env.ledger().timestamp(),
        };
        put(&env, &key, &adv);
        set_pool(&env, &asset, sub(pool, amount)?);

        transfer(&env, &asset, &env.current_contract_address(), &user, amount);
        AdvanceIssued {
            user,
            asset,
            principal: amount,
            fee,
            owed,
        }
        .publish(&env);
        Ok(())
    }

    pub fn repay(env: Env, user: Address, amount: i128) -> Result<(), Error> {
        when_active(&env)?;
        user.require_auth();
        positive(amount)?;
        let party = Party::Account(user.clone());
        let mut adv: Advance =
            get(&env, &DataKey::Advance(party.clone())).ok_or(Error::NoAdvance)?;
        let asset = adv.asset.clone().ok_or(Error::WrongMode)?;

        let applied = apply_repayment(&env, &party, &mut adv, amount)?;
        set_pool(&env, &asset, add(pool_of(&env, &asset), applied)?);

        transfer(
            &env,
            &asset,
            &user,
            &env.current_contract_address(),
            applied,
        );
        Repaid {
            user,
            amount: applied,
            owed: adv.owed,
        }
        .publish(&env);
        Ok(())
    }

    pub fn record_advance(
        env: Env,
        user_ref: BytesN<32>,
        amount: i128,
        fee: i128,
    ) -> Result<(), Error> {
        when_active(&env)?;
        require_partner(&env);
        positive(amount)?;
        if fee < 0 {
            return Err(Error::InvalidAmount);
        }
        let party = Party::Ref(user_ref.clone());
        if amount > limit(&env, &party) {
            return Err(Error::OverLimit);
        }
        let key = DataKey::Advance(party);
        if env.storage().persistent().has(&key) {
            return Err(Error::AdvanceOpen);
        }
        let owed = add(amount, fee)?;
        let adv = Advance {
            principal: amount,
            fee,
            owed,
            asset: None,
            opened_ts: env.ledger().timestamp(),
        };
        put(&env, &key, &adv);

        AdvanceRecorded {
            user_ref,
            principal: amount,
            fee,
            owed,
        }
        .publish(&env);
        Ok(())
    }

    pub fn record_repayment(
        env: Env,
        user_ref: BytesN<32>,
        amount: i128,
        payment_ref: BytesN<32>,
    ) -> Result<(), Error> {
        when_active(&env)?;
        require_partner(&env);
        positive(amount)?;
        let party = Party::Ref(user_ref.clone());
        let mut adv: Advance =
            get(&env, &DataKey::Advance(party.clone())).ok_or(Error::NoAdvance)?;
        let applied = apply_repayment(&env, &party, &mut adv, amount)?;

        RepaymentRecorded {
            user_ref,
            amount: applied,
            owed: adv.owed,
            payment_ref,
        }
        .publish(&env);
        Ok(())
    }

    // ----- views -----------------------------------------------------------

    pub fn config(env: Env) -> Config {
        let s = settings(&env);
        Config {
            // Always set by the constructor.
            admin: access_control::get_admin(&env).unwrap(),
            partner: s.partner,
            assets: s.assets,
            advance_fee_bps: s.advance_fee_bps,
        }
    }

    pub fn group(env: Env, group_id: u32) -> Result<Group, Error> {
        load_group(&env, group_id)
    }

    pub fn pot(env: Env, pot_id: u32) -> Result<Pot, Error> {
        load_pot(&env, pot_id)
    }

    pub fn advance_of(env: Env, party: Party) -> Option<Advance> {
        get(&env, &DataKey::Advance(party))
    }

    pub fn limit_of(env: Env, party: Party) -> i128 {
        limit(&env, &party)
    }

    pub fn record_of(env: Env, user_ref: BytesN<32>) -> RecordSummary {
        record(&env, &user_ref)
    }

    pub fn pool_balance(env: Env, asset: Address) -> i128 {
        pool_of(&env, &asset)
    }
}

/// OpenZeppelin access control: exposes admin transfer/renounce and role views.
#[contractimpl(contracttrait)]
impl AccessControl for Plus {}

mod test;
