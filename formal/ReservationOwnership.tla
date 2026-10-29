---------------------- MODULE ReservationOwnership ----------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANT Mutation
Keys == {"k1", "k2"}
Callers == {"c1", "c2"}
Tokens == 1..3
Foreign == 4
Clocks == 0..3
Deadlines == 1..2
Kinds == {"grant", "settle", "fence"}
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
  /\ fresh[k] < 3
  /\ clock < d
  /\ (Mutation = "allow-active" \/ Admissible(k))
  /\ (Mutation = "ignore-replay" \/ ReplayMatches(k, r))
  /\ LET n == fresh[k] + 1 IN
       /\ fresh' = [fresh EXCEPT ![k] = n]
       /\ latest' = [latest EXCEPT ![k] = n]
       /\ state' = [state EXCEPT ![k][n] = "active"]
       /\ expiry' = [expiry EXCEPT ![k][n] = d]
       /\ history' = RecordEvent(k, "grant", n, r, c)
  /\ UNCHANGED clock

\* All callers may hold aliases; caller identity grants no authority.
Settle(k, n, outcome) ==
  /\ state[k][n] = "active"
  /\ latest[k] = n
  /\ LET success == clock < expiry[k][n] /\ outcome = "confirmed"
     IN /\ state' = [state EXCEPT ![k][n] =
                         IF success THEN "settled" ELSE "fenced"]
        /\ history' = RecordEvent(k, IF success THEN "settle" ELSE "fence",
                                   n, 0, "c1")
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
  \/ \E k \in Keys, c \in Callers, d \in Deadlines, r \in 0..3:
       Reserve(k, c, d, r)
  \/ \E k \in Keys, n \in Tokens,
        outcome \in {"confirmed", "unconfirmed", "invalid-attempt"}:
       Settle(k, n, outcome)
  \/ \E k \in Keys, n \in Tokens: Fence(k, n)
  \/ \E k \in Keys, n \in Tokens \cup {Foreign}: RejectToken(k, n)
  \/ \E t \in Clocks: MoveClock(t)

TypeOK ==
  /\ Mutation \in {"none", "allow-active", "ignore-replay"}
  /\ clock \in Clocks
  /\ fresh \in [Keys -> 0..3]
  /\ latest \in [Keys -> 0..3]
  /\ state \in [Keys -> [Tokens -> States]]
  /\ expiry \in [Keys -> [Tokens -> 0..2]]
  /\ history \in [Keys -> Seq([kind: Kinds, token: Tokens,
                               replay: 0..3, caller: Callers])]
  /\ \A k \in Keys: Len(history[k]) <= 6

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
=============================================================================
