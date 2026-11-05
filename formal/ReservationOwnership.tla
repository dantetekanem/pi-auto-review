---------------------- MODULE ReservationOwnership ----------------------
EXTENDS Naturals, Sequences, FiniteSets
\* GrantLimit bounds fresh tokens per key. Each other constant is a safeguard:
\* TRUE in every configuration except the mutant check that turns it off.
CONSTANTS GrantLimit, ActiveBlocksGrant, ReplayMustMatch, SettleNeedsConfirmation
Keys == {"k1", "k2"}
Callers == {"c1", "c2"}
Tokens == 1..GrantLimit
Foreign == GrantLimit + 1
Clocks == 0..3
Deadlines == 1..2
Kinds == {"grant", "settle", "unconfirmed-settle", "fence"}
States == {"unused", "active", "settled", "fenced"}
VARIABLES clock, fresh, latest, state, expiry, history
vars == <<clock, fresh, latest, state, expiry, history>>

\* Histories are evidence, not admission state; rejects do not grow them.
Event(kind, token, replay, caller) ==
  [kind |-> kind, token |-> token, replay |-> replay, caller |-> caller]
RecordEvent(k, kind, n, r, c) ==
  [history EXCEPT ![k] = Append(@, Event(kind, n, r, c))]
Init ==
  /\ clock = 0
  /\ fresh = [k \in Keys |-> 0]
  /\ latest = [k \in Keys |-> 0]
  /\ state = [k \in Keys |-> [n \in Tokens |-> "unused"]]
  /\ expiry = [k \in Keys |-> [n \in Tokens |-> 0]]
  /\ history = [k \in Keys |-> <<>>]

\* Sensitivity controls mutate this model only, not TypeScript semantics.
Admissible(k) == IF latest[k] = 0 THEN TRUE
  ELSE state[k][latest[k]] = "settled"
ReplayMatches(k, r) ==
  IF latest[k] = 0 THEN r = 0
  ELSE IF state[k][latest[k]] = "settled" THEN r = latest[k]
  ELSE r = 0
Reserve(k, c, d, r) ==
  /\ fresh[k] < GrantLimit
  /\ clock < d
  /\ (~ActiveBlocksGrant \/ Admissible(k))
  /\ (~ReplayMustMatch \/ ReplayMatches(k, r))
  /\ LET n == fresh[k] + 1 IN
       /\ fresh' = [fresh EXCEPT ![k] = n]
       /\ latest' = [latest EXCEPT ![k] = n]
       /\ state' = [state EXCEPT ![k][n] = "active"]
       /\ expiry' = [expiry EXCEPT ![k][n] = d]
       /\ history' = RecordEvent(k, "grant", n, r, c)
  /\ UNCHANGED clock

\* All callers may hold aliases; caller identity grants no authority.
\* Only the SettleNeedsConfirmation mutant can record an unconfirmed-settle.
Settle(k, n, outcome) ==
  /\ state[k][n] = "active"
  /\ latest[k] = n
  /\ LET confirmed == clock < expiry[k][n] /\ outcome = "confirmed"
         success == confirmed \/ ~SettleNeedsConfirmation
     IN /\ state' = [state EXCEPT ![k][n] =
                         IF success THEN "settled" ELSE "fenced"]
        /\ history' = RecordEvent(k, IF confirmed THEN "settle"
                                     ELSE IF success THEN "unconfirmed-settle"
                                     ELSE "fence", n, 0, "c1")
  /\ UNCHANGED <<clock, fresh, latest, expiry>>
Fence(k, n) ==
  /\ state[k][n] = "active"
  /\ state' = [state EXCEPT ![k][n] = "fenced"]
  /\ history' = RecordEvent(k, "fence", n, 0, "c1")
  /\ UNCHANGED <<clock, fresh, latest, expiry>>
RejectToken(k, n) ==
  /\ IF n = Foreign THEN TRUE
     ELSE state[k][n] # "active" \/ latest[k] # n
  /\ UNCHANGED vars
MoveClock(t) ==
  /\ clock' = t
  /\ UNCHANGED <<fresh, latest, state, expiry, history>>
Next ==
  \/ \E k \in Keys, c \in Callers, d \in Deadlines, r \in 0..GrantLimit:
       Reserve(k, c, d, r)
  \/ \E k \in Keys, n \in Tokens,
        outcome \in {"confirmed", "unconfirmed", "invalid-attempt"}:
       Settle(k, n, outcome)
  \/ \E k \in Keys, n \in Tokens: Fence(k, n)
  \/ \E k \in Keys, n \in Tokens \cup {Foreign}: RejectToken(k, n)
  \/ \E t \in Clocks: MoveClock(t)
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ GrantLimit \in Nat \ {0}
  /\ {ActiveBlocksGrant, ReplayMustMatch, SettleNeedsConfirmation} \subseteq BOOLEAN
  /\ clock \in Clocks
  /\ fresh \in [Keys -> 0..GrantLimit]
  /\ latest \in [Keys -> 0..GrantLimit]
  /\ state \in [Keys -> [Tokens -> States]]
  /\ expiry \in [Keys -> [Tokens -> 0..2]]
  /\ history \in [Keys -> Seq([kind: Kinds, token: Tokens,
                               replay: 0..GrantLimit, caller: Callers])]
  /\ \A k \in Keys: Len(history[k]) <= 2 * GrantLimit

\* Prefix-derived evidence never consults latest/state admission slots.
Grants(h, i) == {j \in 1..i : h[j].kind = "grant"}
Closed(h, i) == {h[j].token : j \in {x \in 1..i : h[x].kind # "grant"}}
Open(h, i) == {h[j].token : j \in Grants(h, i)} \ Closed(h, i)
Justified(h, i) ==
  LET prior == Grants(h, i - 1) IN
    IF prior = {} THEN h[i].replay = 0
    ELSE /\ i > 1
         /\ h[i - 1].kind = "settle"
         /\ h[i - 1].token = h[i].replay
         /\ \A j \in prior: h[j].replay # h[i].replay
NoUnjustifiedReacquisition ==
  \A k \in Keys:
    LET h == history[k] IN
      /\ \A i \in 0..Len(h): Cardinality(Open(h, i)) <= 1
      /\ \A i \in Grants(h, Len(h)): Justified(h, i)
      /\ \A i \in 1..Len(h): h[i].kind = "fence" =>
           \A j \in (i + 1)..Len(h): h[j].kind # "grant"

\* Controls: the checker must violate each one, so the rule's states are reachable.
NeverReacquired ==
  \A k \in Keys: Cardinality(Grants(history[k], Len(history[k]))) <= 1
NeverFenced ==
  \A k \in Keys: \A i \in 1..Len(history[k]): history[k][i].kind # "fence"
=============================================================================
