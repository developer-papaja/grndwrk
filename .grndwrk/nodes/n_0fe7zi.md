---
id: n_0fe7zi
type: idea
title: Let colleagues without the iOS project send comments, through a shared server
topic: comments
topic_by: claude
page: Feedback
altitude: 4
links: []
status: open
created: 2026-11-05
---
It would be really cool to be able to point grndwrk at a server or database instead of saving everything locally on your machine, if you wanted. I understand that is something else. But it would close a gap we have today: colleagues who do not have the iOS project locally cannot comment.

This goes against a principle of grndwrk: no accounts, no cloud, no database, `.grndwrk/` is the source of truth. The gap might be closed with less than moving the map to a server.
## Plan: a relay for colleagues on TestFlight

Decided: a small relay that grndwrk ships and you host yourself, on Cloudflare. Anyone on the team can fetch; colleagues join by link or QR code; TestFlight gets its own Beta build configuration. The map stays local and in git; only comments, and the answers about them, pass through. Nothing is built yet. The questions in the thread decide the open points.

**How it works**

- **The phone talks to the relay like it talks to the Mac today.** It wraps the same requests it makes on the Wi-Fi (a comment, a picture of a screen, tested, show, remove) in a sealed envelope and leaves it at the relay. Your grndwrk, while running, fetches the envelopes, opens them and handles each one as if it came over `--lan`, with `via: relay`. So comments, Reject and Approve, and Show on my Mac work the same.
- **Answers go back the same way.** For each colleague's phone, grndwrk leaves a sealed list of their comments' status at the relay (fix proposed, ready to test, fixed, with what changed and the steps). The phone reads it, so "ready to test" and the Test card work away from the Wi-Fi.
- **Not live, but close.** A comment waits at the relay until a grndwrk on the team fetches it, every 15 seconds while it runs, at once when it starts. Whoever's grndwrk runs first takes it into their map, and git brings it to everyone else.
- **Who wrote it.** Each invite has the colleague's name. Their comments say so (`from: Anna`, with `via: relay`), on the card and in the Feedback page. The phone already keeps comments when nothing answers, and says "sent" once the relay has them.
- **The phone tries the Wi-Fi first,** as today, and uses the relay only when no grndwrk answers there.

**Keys and invites**

- **An invite per colleague, by name.** In the map: Invite a colleague, with their name. It shows a link to send and a QR code to scan. In the app they join once (long press, Join with an invite): paste the link, or scan the code. Scanning needs the camera, so the app must say why in its Info.plist (`NSCameraUsageDescription`); without that, the app offers only the link. The invite holds the relay's address and a one-time secret.
- **The phone makes its own key.** On joining, the phone makes a new 256-bit key and sends it to your grndwrk sealed with the invite's secret. grndwrk then forgets the invite. A link forwarded after it was used is worth nothing.
- **Two keys from one.** From the phone's key come a signing key, which the relay knows to check requests (the same signing as `--lan` today: time, nonce, body hash), and an encryption key, which only the phone and your grndwrk know. The relay can refuse strangers, but cannot read or change a comment. If it does, grndwrk sees it and drops the envelope.
- **The team shares one key.** The first person to set up the relay gets a team key. Teammates connect their grndwrk once with a team link (`npx grndwrk relay join <link>`), kept in grndwrk's folder on their Mac, never in the project. The phones' keys are kept at the relay sealed with the team key, so every teammate's grndwrk can open the comments and answer the phones, and the relay still cannot.
- **Take a colleague out** in the map, under Sites, where phones and sites are listed today. The relay forgets their signing key at once.

**The relay**

- **One small Cloudflare Worker, with a mailbox per project,** set up once with one command (`npx grndwrk relay deploy`, on your own Cloudflare account, free plan), then `grndwrk relay add` in each project that uses it. Each mailbox is a Durable Object of its own, so comments always reach the project they were made in. Only whoever deployed the relay opens a mailbox, with an owner key kept on their Mac. Someone else using grndwrk sets up their own relay; teammates and testers need no Cloudflare account. Its code lives in this repo under `relay/`, about 300 lines, tested with Cloudflare's local runner.
- **It keeps only sealed envelopes,** each deleted once fetched, or after 30 days. Limits per phone and in all (like `--lan`: 4 MB a body, so many an hour), so a flood stays inside the free plan.
- **Each teammate's grndwrk signs in to the relay with the team key,** kept in grndwrk's folder on their Mac (`stateDir`), never in the project. With it, grndwrk fetches, hands out invites and sends each phone the status of its comments. When two teammates' maps say different things about a comment, the newest change wins.

**The app**

- **A Beta build configuration for TestFlight** (decided). TestFlight builds run the button only with `start(allowOutsideDebug: true)`, and the same build can later be released to the App Store. The package already does nothing in an App Store build; with Beta, the button and the relay's address are not even in the App Store binary. The README shows how to set it up in Xcode.
- **What changes in the package:** Join with an invite (paste or scan), sealing and signing for the relay, reading status from it, and choosing Wi-Fi or relay. Everything else stays.

**In steps**

1. The relay itself, with its tests.
2. grndwrk: deploy, the team key and joining, invites with names and QR codes, fetching, status for each phone, Sites listing colleagues.
3. The package: joining, sealing, choosing the route, words on the phone.
4. A security review of all of it before it is published: it is the first part of grndwrk that faces the internet.
5. README: how to set it up, and what the relay can and cannot see.

What stays as it is: no accounts, the map only in `.grndwrk/`, `--lan` unchanged, and someone who never sets up a relay never sees any of it.
