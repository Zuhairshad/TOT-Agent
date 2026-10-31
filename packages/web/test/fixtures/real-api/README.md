# Real Worker responses (contract fixtures)

These JSON files were captured with `curl` from a local Worker run on 2026-10-31 that had ingested
the World Bank open API (15 Zambian procurement notices) and one blocked TendersOnTime scan.
They are real responses, **not synthetic**. They contain real World Bank notice data; e-mail
addresses (there were none) would have been removed.

| File                                           | Request                                     |
| ---------------------------------------------- | ------------------------------------------- |
| `list.json`                                    | `GET /api/tenders?pageSize=100`             |
| `detail-award-ppe.json`                        | `GET /api/tenders/worldbank%3AOP00282200`   |
| `detail-motorcycle-helmets.json`               | `GET /api/tenders/worldbank%3AOP00065710`   |
| `scans.json`                                   | `GET /api/scans`                            |
| `shortlist-put.json` / `shortlist-delete.json` | `PUT` / `DELETE /api/shortlist/:id`         |
| `shortlist.json`                               | `GET /api/shortlist` (one id shortlisted)   |
| `config.json`                                  | `GET /api/config` (packaged default)        |
| `scan-start-501.json`                          | `POST /api/scans` (dispatch not configured) |
| `error-400.json`, `error-401.json`             | bad `sort`; missing token                   |

`test/contract.test.ts` feeds them through the real `ApiClient` and renders the views. To refresh
them, re-run the requests against a running Worker; never edit them by hand.
