# Service Request Demo

A small, browser-only React and TypeScript demo, built with Vite, in which one person plays a simulated Requester or Reviewer to create, edit, submit, review and complete fictional service requests, each with an append-only audit history.

## About this demo

Every view shows this banner:

> Demo only. Fictional data. Role switch is a simulation, not authentication. Data is stored in this browser only.

- **Fictional data.** All data — the sample requests, the test fixtures and this documentation — is fictional. Real names, contact details and personal data do not belong in it.
- **Storage.** Everything is stored in the browser's local storage under one key, `service-request-demo.v1`, holding `{ "version": 1, "requests": [...] }`. The app writes it after each successful change and reads it on startup. Nothing is sent anywhere.
- **First run.** With no stored data, the app shows three sample requests in memory — `REQ-0001` (Alex Example, Draft), `REQ-0002` (Jordan Sample, In Review) and `REQ-0003` (Casey Placeholder, Waiting for Information) — and writes them only with the first successful change.
- **Reset.** The header button "Reset demo data" asks for confirmation. "Confirm reset" replaces all stored data with the three sample requests; "Cancel" changes nothing.
- **Storage problems.** Stored data that cannot be read, or that uses an unsupported version, is left untouched, and a notice offers "Reset to sample data". The stored value is replaced only when you confirm a reset or complete a successful change. If storage is unavailable or full, the app keeps working in memory and warns that changes will not persist after this session.

### Workflow

A request moves Draft → Submitted → In Review → Waiting for Information ⇄ In Review → Completed. Completed is final: neither role is offered any action on it.

| Action | Role | From | To |
| --- | --- | --- | --- |
| Create | Requester | none | Draft |
| Edit | Requester | Draft | Draft |
| Submit | Requester | Draft | Submitted |
| Start review | Reviewer | Submitted | In Review |
| Request more information | Reviewer | In Review | Waiting for Information |
| Supply information | Requester | Waiting for Information | In Review |
| Complete | Reviewer | In Review | Completed |

- Drafts may be saved incomplete. Submit requires a requester name (at most 80 characters), a request type and a description (at most 2000 characters).
- Request more information requires a reason, and Supply information requires the supplied information, each at most 1000 characters.
- Priority is Normal or Urgent. Every new request starts as Normal, and the Requester changes it only through Edit while the request is a Draft. The change is recorded in the `Edited` audit entry's note, for example "Priority: Normal to Urgent".
- Every create, edit and status change appends one audit entry with its timestamp, role, action, previous status, new status and any note. Entries are never edited, removed or reordered.

## Getting started

Prerequisites: Node.js 22 LTS or Node.js 24 LTS (`engines`: `^22.22.2 || ^24.15.0 || >=26.0.0`) and npm 10 or later. Node.js 20 is not supported: it is past end of life and the toolchain rejects it. npm is the only supported package manager.

No environment variables, secrets or external configuration are needed.

Install the exact pinned dependencies from `package-lock.json`:

```bash
npm install
```

Start the Vite dev server, then open `http://localhost:5173/`:

```bash
npm run dev
```

Run every Vitest suite once, without watch mode:

```bash
npm test
```

Type-check strictly with `tsc --noEmit`, then write the production bundle to `dist/`:

```bash
npm run build
```

Serve the built `dist/` on `http://localhost:4173/`:

```bash
npm run preview
```

## Demo role switch

- The header control "Role (demo simulation, not authentication)" switches between Requester and Reviewer.
- The selected role decides which actions are offered, and it is recorded as text in each audit entry.
- It is a simulation, not authentication: it checks no identity and protects nothing.
- The role is not saved. The app always opens as Requester.

## Limitations

- Data lives in this one browser profile only. Clearing site data deletes it, and in private browsing it is lost when the window closes.
- The role switch provides no security: anyone can act as either role, and stored data can be edited with the browser's developer tools.
- No concurrent editing: nothing syncs between tabs, browsers or users. Changes made in another tab are not picked up, and the last write wins.
- Not designed for production use or for real personal data.
- Out of scope for this version: editing after submission, deleting individual requests, search, filtering, sorting, pagination, attachments, notifications, and export or import.

## Manual smoke check

This check confirms that no network request is made after load. Run it against the production build, not the dev server, because Vite's dev server keeps its own hot module replacement (HMR) WebSocket open.

1. Run `npm run build`, then `npm run preview`, and open `http://localhost:4173/` in current Chrome, Firefox or Safari.
2. Open DevTools → Network with "Preserve log" on, and reload. Only the page, its one script and its one stylesheet load, all from `localhost`. A `data:` favicon entry, if the browser lists one, is not a network request.
3. Clear the log. Then, switching the role as each action requires: create a request, edit its priority, submit it, start review, request information, supply it, complete it, and reset.
4. Confirm the Network log stays empty.
