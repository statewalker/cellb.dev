---
"@statewalker/cellb": patch
---

Alarms and cron triggers more than about 24.8 days ahead now fire once, when they are due. setTimeout takes at most 2^31 − 1 ms and fires any longer delay after 1 ms. Before this fix:

- An alarm set further ahead fired at once, found itself not yet due, re-armed, and woke its object every millisecond. celld's workflows set 30-day alarms.
- A cron trigger whose next occurrence was that far off ran its `scheduled()` handler at once, with the future `scheduledTime`. Examples are a yearly trigger or a monthly one on the 31st.

Both now wait in steps of at most 2^31 − 1 ms.
