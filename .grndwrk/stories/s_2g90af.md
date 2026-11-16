---
id: s_2g90af
title: See every screen, what it is for and who it is for
status: done
from: [n_gzuvjc, n_ciapve, n_ezj8z3, n_d5sktq, n_ps3s9e]
applies_to: ["commands/sitemap.md", "src/store/screens.ts", "src/shared/screens.ts", "ui/index.html"]
created: 2026-11-16
---
As someone joining a product that exists, I want its screens drawn as a site map with their purpose,
so that I know what I am looking at before I change anything.

## Acceptance
- [x] `/sitemap` writes one file per screen from the code: purpose, who it is for, what they do, the tree and the links
- [x] The Sitemap view draws the tree with pictures of the screens, zooms and pans, or shows it as a list
- [x] Purpose, who it is for and what they do there are changed in the panel, and guesses are asked about
- [x] Parts that do not connect show as sitemaps of their own, and screens can be hidden for everyone
