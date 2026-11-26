# Pilot acceptance run (2026-11-26)

Restaurant slug: `uat-517676` (test data on a throwaway database). **29 of 29 steps passed.**

| # | Step | Result | Time |
|---|---|---|---|
| 1 | A prospect submits the lead form (with consent) | PASS | 12 ms |
| 2 | The operator sees the lead and an alert event in Super Admin | PASS | 15 ms |
| 3 | The operator provisions the restaurant from the lead (no UPI ID invented, 14-day trial plan) | PASS | 255 ms |
| 4 | The owner receives credentials and signs in with the temporary password | PASS | 269 ms |
| 5 | The owner must choose their own password before anything else works | PASS | 1019 ms |
| 6 | The owner sets up the restaurant profile (GST) in Settings | PASS | 21 ms |
| 7 | The owner imports the menu from a spreadsheet (check first, then import) | PASS | 38 ms |
| 8 | The owner adds more tables (within the trial's 20-table limit) | PASS | 36 ms |
| 9 | A table's QR link opens THIS restaurant's menu | PASS | 5 ms |
| 10 | The owner adds a cashier and a steward, who choose their own passwords | PASS | 3878 ms |
| 11 | The owner sets the kitchen PIN | PASS | 533 ms |
| 12 | The kitchen device signs in with the restaurant code and PIN | PASS | 534 ms |
| 13 | The go-live checklist honestly shows what is still to do | PASS | 18 ms |
| 14 | A diner opens the menu; UPI is NOT offered until the owner confirms the ID | PASS | 20 ms |
| 15 | The owner adds and confirms their own UPI ID; guests now see who they are paying | PASS | 118 ms |
| 16 | The diner places an order; a retry with the same key returns the same order | PASS | 44 ms |
| 17 | The kitchen sees the order, without money or contact details | PASS | 12 ms |
| 18 | The kitchen starts cooking | PASS | 26 ms |
| 19 | The kitchen marks the order ready | PASS | 28 ms |
| 20 | The guest's tracking link follows the order | PASS | 6 ms |
| 21 | The cashier marks it paid: exactly one GST bill with the tax split | PASS | 57 ms |
| 22 | The steward serves it and completes the order | PASS | 29 ms |
| 23 | Reports show the sale and the GST collected | PASS | 19 ms |
| 24 | A paid order is cancelled and refunded: one credit note, linked to the bill | PASS | 152 ms |
| 25 | Inventory: a recipe is set and a sale reduces stock | PASS | 113 ms |
| 26 | The kitchen device, after being offline, finds every open order by re-reading the list | PASS | 81 ms |
| 27 | Plan enforcement: when the platform switches the kitchen display off, the kitchen is refused; switching it back restores it | PASS | 544 ms |
| 28 | After the owner records the physical steps, the go-live checklist is complete | PASS | 74 ms |
| 29 | The audit trail recorded the money and setup actions with who did them | PASS | 2 ms |
