# Daily Rocket Money upkeep

Instructions for a scheduled assistant run, once a day. Each run files new
transactions, ignores transfers between my own accounts, matches repayments to the
charges they repay, and writes a structured entry to `LOG.local.md` in this folder. A rule
is added or changed only when the log shows a pattern, and only through the
verification protocol in section 6.

This file is committed and holds no personal data. Ids, names and per-person patterns are
in `../CATEGORIZATION.local.md`. The log is `LOG.local.md`: gitignored (`*.local.md`),
because it names people and amounts.

## 0. Read first, every run

1. `../CATEGORIZATION.md`: the conventions (filing by purpose, netting repayments, the
   `Venmo` category, dates). Sections 1 to 4 and 7 apply as written.
2. `../CATEGORIZATION.local.md`: account and category ids, who usually pays for what, rent.
3. `LOG.local.md`: the last few entries, for the date of the last run, open review items,
   and the rule-candidate tally (section 5).

`CATEGORIZATION.md` lists the tools each step uses (§5 and §7).

## 1. Hard limits

- **Venmo: reads, and requests for money I'm owed.** Reads: `get_transactions`,
  `get_outgoing_requests`, `get_pending_requests`, `get_friends`, `lookup_user`,
  `search_users`, `get_my_profile`. Requesting money (`request_money`, `split_request`) is
  allowed, under section 4a. Never call `send_money`, `complete_request`, `deny_request`,
  `cancel_request` or `remind_request`: nothing that pays, or that changes a request
  someone else made.
- **Rocket Money writes allowed:** `set_transactions_category`, `set_transaction_ignore`,
  `set_transaction_notes`, `set_transaction_date`, and rule writes only under section 6.
  Never call `delete_category`, `update_category`, `update_subscription`,
  `delete_subscription`, `mark_subscription_active` or `set_asset_value`.
- **Never use** `set_transaction_category` with `apply_to_all=true`. It sweeps every
  transaction from the merchant, across all history.
- **At most 150 transactions changed per run.** If more need changing, do the oldest 150
  and record the rest under misc context.
- **At most one rule created, edited or deleted per run.**
- **If `session_status` isn't authenticated, or a write fails twice,** stop writing. Log
  what was done and the error, then end the run.
- **Don't change a transaction you've already decided,** that is one listed under fixes in
  an earlier log entry, unless new evidence shows the earlier call was wrong. If you do
  change one, say so under fixes, giving the earlier entry's date.

## 2. Collect

0. `session_status`. For each entry in `stale_connections` (an institution that stopped
   syncing), add a review item: "Reconnect <institution> in the Rocket Money app: nothing
   after <last_transaction> is visible". Charges on that account are missing, so a
   repayment for one won't find its match: file it by its note and mark it `uncertain`.
   Repeat the item every run until it's gone.
1. Window start = the last run's date minus 7 days (pending charges settle late). For the
   first run, use 30 days ago.
2. `search_transactions(since=<start>, date_field="original_date", limit=2000)`. Use full
   rows, not compact: notes, renames and rule ids matter here. If there's a `next_cursor`,
   keep paging.
3. Also collect anything still unresolved regardless of date:
   - `category_transactions("Venmo", since=<30 days ago>)`: anything in `Venmo` that isn't a
     transfer between my own accounts.
   - `category_transactions("Internal Transfers", since=<start>)`: incoming `Zelle payment
     from …` that Rocket Money auto-filed there, and Venmo payments from a person (a paid
     request lands there ignored, e.g. a `… group split` I requested). Those are
     repayments: file them by purpose and un-ignore them.
   - Open review items from earlier log entries.
   - **Recurring subscriptions.** Compare the window against the "Recurring subscriptions"
     table in `../CATEGORIZATION.local.md`. If a newer monthly Link summary email has arrived
     (Gmail: `from:notifications@link.com subject:"transaction summary"`), read it and add any
     merchant or price not in the table (that's a local-file edit, not a Rocket Money write;
     log it under fixes). Under needs review, flag: a listed subscription that didn't charge
     within 5 days of its usual day, a price change, or a new recurring merchant.
4. Snapshot before any write:
   - `spending_summary` (category totals);
   - `list_rules` (count and ids);
   - for every transaction you might change: id, category, ignore, date, note.

## 2a. Cash-flow check: will checking cover the automatic payments?

Read-only; no writes. Run it every day, even when nothing else changed.

1. **Balances.** `get_account(<checking id>)` for the checking balance (use `availableBalance`
   when it's lower than `currentBalance`). `list_accounts` for every credit card's current
   balance; `get_account` on each card with a balance for `liability` (statement balance,
   due date) when Rocket Money has it.
2. **Outflows from checking over the next 35 days.** Use the schedule in
   `../CATEGORIZATION.local.md` ("Automatic payments from checking") as the list of what
   leaves checking and roughly when, and confirm each against the last few months of
   checking rows (`search_transactions(account_ids=[<checking id>], since=<~60 days ago>)`).
   - **Card autopays, by billing cycle.** Each autopay pays one statement, so work out
     which charges land in it:
     - **Dates:** the card's statement close and autopay dates. Best source: the latest
       Gmail notice (Amex "AutoPay Reminder" gives amount and processing date; Chase
       "statement is available" gives due date and statement balance; Citi and others: the
       statement-ready email date ≈ close + 1–2 days). Then `liability` from `get_account`,
       then the usual days in the local file. A due date on a weekend or holiday pays the
       business day before (Chase) or after (check the issuer's email).
     - **Amount once the statement has closed:** the statement balance (email or
       `liability`), or, failing those, the card's balance on the close date from
       `get_account` balanceHistory. It's firm; mark the basis `statement`.
     - **Amount before it closes:** current balance plus the card's average daily spend
       over the last 30 days × days left until close. Mark it `estimate`. Charges after the
       close date belong to the following payment, so don't load them onto this one.
     - If this cycle's payment has already posted, the next one is a cycle later.
     - **Card balances lag payments.** If a payment to the card has posted on checking
       but the card's balance hasn't dropped, don't use the balance: add up the card's
       charges since the last statement close instead.
   - **Bills paid from checking:** `upcoming_bills(days=35)` for amounts and dates, keeping
     only merchants whose past payments came from checking (bills charged to a card are
     already inside that card's balance; don't count them twice).
   - **Rent** on the schedule in the local file, unless that month's payment has already
     posted.
   - **Disconnected cards** (local file): the latest statement amount from Gmail if known,
     otherwise the last payment.
3. **Inflows:** count only ones that are certain and dated (a scheduled transfer you can
   see, a payroll deposit with a regular history). Never assume a transfer from investments
   or a pending Venmo request.
4. **Project** the checking balance day by day and find the lowest point, its date and
   the payment that causes it (the *breaking payment*).
   - **At risk:** the lowest point is below $0.
   - **Tight:** the lowest point is below the buffer in the local file (default $1,000).
   - Otherwise **ok**.
   - **Shortfall** = buffer − lowest point (the amount that restores the buffer).
   - **Move-by date** = 3 business days before the breaking payment (an ACH transfer from
     a brokerage takes 1–3 business days to land). Count bank holidays.
5. **Notify** (push, the run's notification tool) based on dates, so a warning arrives when
   it's actionable and isn't repeated every day for a month. Send one when any of these is
   true, and otherwise only record the projection in the log and summary:
   - **New:** the last log entry's result was ok (or there is none) and today's isn't.
   - **Firm:** the breaking payment's statement closed since the last run, so its amount
     changed from `estimate` to `statement`.
   - **Worse:** the shortfall grew by more than $1,000 since the last notification.
   - **Countdown:** the move-by date is 7 days away, or 2 days or less away (then daily,
     until it's covered).
   - **Missed:** the move-by date has passed and it's still not covered (daily, and say
     the payment may bounce: a returned autopay can mean a returned-payment fee).
   The first sentence of the push is the action: "Move $<shortfall, rounded up to the next
   $500> into checking by <move-by date> (<weekday>)". Then: the breaking payment, its date
   and amount (`firm` or `estimate`), the lowest projected balance, and the other large
   payments before it. When a not-ok result becomes ok again (money arrived), send one
   short "covered" push.

Record the projection in the log's cash-flow section (section 7) and lead the summary
with it when it's not ok.

## 3. Decide each transaction

Work through these in order. Record a confidence for each: **high**, **medium** or
**low**.

| Kind | How to recognize it | Action |
| --- | --- | --- |
| Transfer between my own accounts | The rows in `CATEGORIZATION.md` §2 (`Standard transfer`, `VENMO CASHOUT`, `VENMO PAYMENT`), credit card payments, moves between my own bank or brokerage accounts | Category `Venmo` for the Venmo-related ones; everything else keeps Rocket Money's transfer or payment category. `ignore: everything` in both cases. |
| Repayment of a group bill | Incoming Venmo or Zelle whose amount is the charge divided by N, or a round share of it, near a charge of mine; or a note naming it (`airbnb`, `dinner`, `… group split`) | The charge's category (§1). If the charge is in a different month, also re-date the repayment to the charge's date (§7). Note: `repays <merchant> <YYYY-MM-DD>` |
| Payment to a person | Outgoing Venmo or Zelle | Category by purpose, from the note (§4) |
| New bill | A charge from a utility, telecom, insurer, rent, a subscription, or anything `subscriptions` / `upcoming_bills` / the "Recurring subscriptions" table in `../CATEGORIZATION.local.md` lists, that isn't in its usual category | Its usual category: the one past charges from the same merchant use (`search_transactions(query=<merchant>)`). For a merchant with no history, the category from the merchant type (`Bills & Utilities`, a subscription category, `Rent`). |
| Future trip or event purchase | Flights, lodging, tickets, tours, booked ahead | Re-date per §7 when the event date is known (Gmail confirmations if available). Note: `dated to <event> <YYYY-MM-DD>` |
| Payment to a card that isn't syncing | A payment from checking to a card that `CATEGORIZATION.local.md` lists as disconnected | Its purchases never arrive, so the payment stands in for them: `Shopping` (or the card's usual category), ignore `none`, note `proxy for <card> purchases (disconnected since <date>)`. If the card reconnects with history, revert the payments the history covers to `Credit Card Payment` + `ignore: everything`. |
| Duplicate import | Same name and amount on the same account, within 2 days, with a new id | Per §3 of `CATEGORIZATION.md`: newer copy → `Ignore`. Only when a whole stretch is doubled, never a single pair. |
| Everything else | | Leave Rocket Money's category, unless it's clearly wrong (e.g. a restaurant in `Shopping`) |

**Confidence and what to do with it:**
- **High:** a note or merchant that settles it, or an exact matching charge. Apply.
- **Medium:** a best guess with real evidence. Apply, and add the note
  `uncertain: <why>`.
- **Low:** no evidence. Don't change it; list it for review.
- **$500 or more:** apply only at high confidence. Otherwise list it for review.

## 4. Apply and verify

1. Apply in batches, one call per target: `set_transactions_category` per category,
   `set_transaction_ignore` per ignore state, `set_transaction_date` per date,
   `set_transaction_notes` once with every note.
2. Check each call's `updatedCount` (or per-item results) against what you sent. List any
   shortfall under MCP bugs.
3. Re-read every changed transaction (`search_transactions`, or `preview_rule` /
   `category_transactions` with the right filters). Confirm category, ignore, date and
   note are what you set.
4. Call `spending_summary` again. Every category's change must equal the sum of what moved
   in or out of it, net of ignore changes. Any unexplained difference is a bug: record it,
   and don't make rule changes this run.
5. `Venmo` must hold only transfers between my own accounts.

## 4a. Requesting money I'm owed

A request notifies the other person, so send one only when all of these hold:
- **The share is certain.** I paid a group charge, and that person's share is stated
  somewhere: a Splitwise group split, a note or message agreeing it, the same split others
  in the group already paid (e.g. the $384 Airbnb shares), or a known pass-through in
  `CATEGORIZATION.local.md`. Never estimate a share.
- **Nothing is pending or paid.** `get_outgoing_requests` has no open request to them for
  this, and `get_transactions` shows no matching payment from them since the charge. The
  Venmo server's duplicate guard is a backstop, not the check.
- **It's due.** At least 7 days have passed since the charge, or since the others in the
  group paid their shares.
- **The recipient is right.** They're in `get_friends` (look them up there, never by a
  guessed username).

Limits: at most 3 requests per run and at most $500 each. Anything larger or less certain
goes under needs review instead. The note names the charge, e.g. `airbnb (homecoming,
Oct 2026)`. Use `split_request` only when the whole split is known.

Log each request under fixes made (change `Venmo request $X to <name>`). When it's paid,
file the payment by purpose like any repayment.

## 5. Spot patterns and propose rules

A rule is only worth having if it's always right with no judgment (`CATEGORIZATION.md`
§6). Candidates: transfers between my own accounts, single-purpose merchants, and a fixed
counterparty with one purpose (rent to one roommate). Never a catch-all for an account or a
person.

Keep a running tally in each log entry's rule proposals: the pattern (exact conditions),
how many transactions it covered this run, and the total across runs. A pattern becomes a
rule **only when all of these hold**:
- it has been handled the same way at least 5 times, across at least 3 runs;
- it had no exceptions in any run;
- its conditions can be written exactly (exact name or contains, plus account or amount
  when needed);
- `preview_rule` passes the checks in section 6.

Otherwise it stays a proposal, with the reason it isn't ready.

## 6. Changing rules: the verification protocol

Rocket Money re-applies overlapping rules unpredictably when any rule is saved, and saving
overwrites hand edits to the fields a rule sets. So every rule change follows all of these
steps, and any failure means stop and undo.

1. **Preview.** Call `preview_rule(conditions, sample_size=2000)` (full rows). For every
   match, the rule's updates must be exactly what this procedure would choose for it. A
   single mismatch means narrow the conditions or drop the proposal.
2. **No overlap.** No match may have a live rule in `applied_rule_ids` that sets the same
   field. `list_rules` shows each rule's updates. If one does, drop the proposal; don't
   delete the other rule to make room.
3. **Snapshot.** Record for every match: id, category, ignore, custom name and note. Also
   record `spending_summary` and the full `list_rules` output.
4. **Save.** `create_rule` (or `update_rule`) with `apply_to_existing=true` only when every
   current match already has the rule's values, or the change to them is intended and
   listed. Otherwise use `apply_to_existing=false`.
5. **Verify after 15 seconds.**
   - Every match has the rule's values, and the rule's id is the **last** of its
     `applied_rule_ids` (the effective rule).
   - No field the rule doesn't set has changed on any match.
   - `spending_summary` changed by exactly the expected amounts, in the expected
     categories, and nowhere else.
   - `list_rules`: the count changed by exactly what you did, and every other rule's
     conditions and updates are identical to the snapshot. An update gives the rule a
     **new** id: record the new one.
6. **If anything fails:** `delete_rule(rule_id)` **without** `undo_changes`. Undo resets
   to the bank's values and would also wipe hand edits. Then restore every changed
   transaction from the snapshot with the batch tools, re-verify against the snapshot, and
   record all of it under MCP bugs and rules modified.

**Editing or deleting an existing rule:** only when the log shows the rule filed something
wrong at least twice. The same protocol applies. Delete with the default (keep the changes
it made), then fix the wrong rows by hand. Never delete a rule only because a new one
overlaps it.

## 7. Write the log entry

Append one entry to the end of `LOG.local.md`, using exactly this structure. Every section
is present every run; write `None.` when empty. Amounts are in USD; transactions are
written `YYYY-MM-DD · name · $amount · account`, plus the id where it's needed for review.

```markdown
## YYYY-MM-DD

**Run:** window <start> → <end> (original_date) · <N> transactions scanned · <M> changed · session ok|failed

### Cash-flow check
**Result:** ok | tight | at risk · checking $<balance> · lowest projected $<X> on <date> (breaking payment: <name>) · shortfall $<Y> · move by <date> · notified: yes (<new|firm|worse|countdown|missed|covered>) | no

| Date | Payment | Amount | Basis | Projected checking after |
| --- | --- | --- | --- | --- |
(every expected outflow and certain inflow in the next 35 days; basis is `statement`,
`estimate`, `last payment`, `upcoming_bills` or `schedule`; for cards also give the
statement close date)

### New transactions
| Date | Name | Amount | Account | Rocket Money category | Decision |
| --- | --- | --- | --- | --- | --- |
(every transaction in the window that's new since the last run; decision is `kept`,
`fixed`, `review`, or `transfer`)

### Fixes made
| Transaction | Change | Confidence | Reason |
| --- | --- | --- | --- |
(category, ignore, date and note changes, one row per transaction)

Totals moved: <category: +$X / −$Y, …>. spending_summary check: passed|failed (<detail>).

### Needs review
| Transaction (id) | Question | Best guess |
| --- | --- | --- |

### Rule proposals
| Pattern (exact conditions) | Update | This run | Total (runs) | Status |
| --- | --- | --- | --- | --- |
(status: `tracking`, `ready`, `blocked: <reason>`, or `done <date>`)

### Rules modified
| Action | Rule id | Conditions → updates | Matches | Verification |
| --- | --- | --- | --- | --- |
(created / edited / deleted / rolled back; verification lists each section 6 check
and its result)

### MCP bugs
| Tool | Action attempted | Failure mode | Exact error | Goal |
| --- | --- | --- | --- | --- |

### Misc context
(Anything the next run should know: limits hit, items deferred, things that looked odd but
weren't changed, open questions for me.)
```

Then reply with a summary: the cash-flow result first (and the amount to move into
checking, if any), what changed (counts and dollars per category), everything
needing review, and any rule or MCP issue.
