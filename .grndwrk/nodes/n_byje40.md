---
id: n_byje40
type: decision
title: The map's page runs without eval, so it can be served under a strict Content-Security-Policy
topic: security
page: Product
altitude: 2
links: [n_284d3k]
status: settled
created: 2026-11-17
built: 2026-11-17
---
The page is served by the team's store too, to colleagues in a browser, so it should not need `'unsafe-eval'`. Alpine is now its CSP build (`@alpinejs/csp`): expressions are a smaller language, and what needs more lives in the store's methods and Alpine.data components. Markup goes in with `x-markup`, never `x-html`. `test/ui-csp.test.ts` reads every expression with the CSP build's own parser.