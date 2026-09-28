# Demo assets

## `contacts.csv` — synthetic CRM export

24 rows, entirely fabricated. No real people, no real companies, all phone
numbers in reserved `555` ranges. Safe to put on a projector.

Built so a duplicate detector has something interesting to say at **every
confidence band**, and so the design conversation about matching strategy has
concrete cases to point at.

### What is planted in it

| Rows | Case | Should score |
|---|---|---|
| 1001 / 1003 | Byte-identical except `created` | **Certain** — exact match |
| 1019 / 1020 | Fully identical duplicate row | **Certain** |
| 1001 / 1002 | "Robert" vs "Bob", email differs, phone same but formatted differently | **High** — nickname + phone normalisation |
| 1008 / 1009 | "James O'Connor" vs "Jim OConnor", apostrophe dropped, company spaced differently | **High** — punctuation + nickname |
| 1014 / 1015 | "Muller" vs "Müller", `t.muller@` vs `t.mueller@` | **High** — diacritic + transliteration |
| 1004 / 1005 | Diacritic, different email local part, company `Acme Industrial` vs `Acme Industrial SA` | **Medium** — legal-suffix noise |
| 1006 / 1007 | Different email local part, company `Helios Health` vs `Helios Health Systems`, title reworded | **Medium** |
| 1012 / 1013 | "Sarah" vs "Sara", same phone, title promoted | **Medium** |
| 1023 / 1024 | Email local part differs, phone spaced differently, `Ltd` suffix added | **Medium** |

### The traps — must NOT be merged

| Rows | Why it looks like a duplicate | Why it is not |
|---|---|---|
| 1010 / 1011 | Same name, same company | **Different phone and different role** — two real people, or one who changed jobs. The judgement call worth showing. |
| 1017 / 1018 | Same name, same title | **Different company and phone** — one person who moved employers. Merging loses history. |
| 1021 / 1022 | Same surname, same company, near-identical email and phone | **Michael vs Michelle** — different people. Punishes naive edit-distance. |
| 1016 | — | Singleton. Proves the tool does not invent matches. |

### Why it is shaped this way

The traps are the point. Anything can find `1019/1020`. A demo that only shows
exact matches proves nothing. These cases force the **threshold** question —
where does confidence stop meaning "merge" — which is exactly the design
decision that makes the DESIGN phase worth watching.

### Use

```sh
cp ~/reg/my/forge/compose/docs/demo-assets/contacts.csv ~/reg/my/testapp/
```

Copy it in **after** the Step 0 reset. Mention on stage that it is synthetic —
it pre-empts the "is that real customer data?" question.
