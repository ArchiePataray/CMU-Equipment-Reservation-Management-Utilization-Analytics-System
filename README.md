# CMU Equipment Reservation, Management and Utilization Analytics

A browser-only demonstration application built with HTML, CSS, and vanilla JavaScript. It starts with no users, categories, equipment, reservations, transactions, notifications, or history.

## Run

Open `index.html` in a modern browser, or serve this folder from a local web server. Use the same browser profile and origin to retain records. There are no package installation or database setup steps.

## First use and roles

1. An authorized local operator can select **Set up first administrator** on the login page, then enter their own account details and choose a password. Setup asks for explicit confirmation and is hidden once an administrator exists. The application cannot verify the operator's identity; anyone with access before the first administrator is set up can claim this role.
2. Members can select **Create account** to register. Public registration creates member accounts only and cannot assign the administrator role.

This browser-only bootstrap is for local demonstration use, not secure provisioning. Client-side role checks can be bypassed; do not expose the app as a production system or treat this as authorization.

## Demonstrate the workflow

1. The application starts with empty categories and equipment. An administrator can create categories and equipment records using the management pages. Existing custom inventory is preserved during updates. The update clears only the exact, untouched sample catalogs that were briefly added by previous versions.
2. As a registered member, select equipment, choose a future schedule, add multiple items and quantities, review the request, and submit it.
3. As an administrator, approve the request or reject it with a reason. Approval creates a QR code tied to that reservation.
4. As the member, open the approved reservation (or its approval notification) to display the QR and reservation ID. Present the QR at the office, copy the ID, download the QR as a PNG, or select **Send QR to Admin**. Sending creates a stored submission and an administrator notification. Approval alone does not create an inbox entry.
5. Confirm the borrower, schedule, equipment, and quantities, then release the equipment. The borrowing transaction references its reservation and reserved items.
6. At return, the administrator verifies the borrowing/reservation ID or check-in QR, confirms the transaction, and records each item's condition. Non-good conditions require remarks. Returns update availability and append linked condition history.
7. Review the resulting notifications, dashboard counts, analytics, reports, and CSV exports. They are derived only from records currently stored in the browser.

Reservation stock and schedule checks, conflict validation, approval/rejection history, QR validation, borrowing, return inspection, maintenance, and member/admin views remain connected. Password recovery displays a verification code in the browser; no email is sent.

Inventory uses **Total stock**, **Available on hand**, **Currently borrowed** and **Under maintenance** to describe current stock. The reservation form identifies equipment by name and ID. Before a schedule is chosen it shows total stock; after valid date/time selection, the dropdown and row message show availability for that schedule. **Quantity to reserve** is the member's request. The +/− controls and input maximum follow the selected schedule's limit (usable stock before scheduling). Typed invalid quantities show an immediate error and remain blocked by review/submission validation. Changing a schedule does not silently reduce a previously entered request. Same-name equipment records remain separate; no inventory records are merged or removed.

## QR verification and interaction

- On **QR Verification**, the administrator can enter a reservation ID or QR value, start the camera to scan a member's phone/printed QR, or upload a PNG, JPG or WebP QR image (up to 10 MB). The image is decoded locally using the bundled jsQR library. Uploaded files are not sent to an external service.
- **QR Codes Sent by Members** contains only explicit submissions. Administrators can open the submitted image, take a screenshot using their device, or download it and then upload the saved image for verification. Opening or downloading a submission does not verify it.
- Members see whether their submission was received, viewed or verified. Successful verification creates a member notification. Verification never releases equipment automatically: borrower identity, schedule, quantities, stock and the reservation date still require the existing checks and release confirmation. Used, cancelled, rejected and mismatched QR codes are rejected.
- Editing the ID, switching verification methods, leaving the page, signing out or hiding the browser cancels camera/image work. The camera stops when a code is read. Camera access requires permission and a secure context (HTTPS or localhost); manual ID and image upload remain available when the camera cannot be used.

**Browser-only scope:** the inbox and notifications are shared by accounts using the same browser profile and app origin. Switch between member and administrator accounts to use this local workflow. Separate devices or browser profiles do not exchange submissions or reservation records. Sharing a downloaded QR externally does not transfer its underlying reservation record; cross-device delivery requires a shared backend, which is not included.

## Existing browser data and reset

The application stores its data in LocalStorage under `cmu_eq_db_v4` and its login session under `cmu_eq_session_v4`. Passwords are stored in browser data. There is no server, MySQL database, API, email service, or server-side authentication.

The current schema is version 12. Existing version 11 records are preserved and an empty QR submission collection is added. Exact, untouched sample catalogs from earlier versions are removed so the inventory returns to an empty state; customized equipment and categories are preserved. Databases older than version 7 are not loaded into the interface or silently overwritten. The app pauses and asks the operator to download a JSON backup or explicitly confirm clearing the old database and saved session. The confirmed reset starts a new empty database. Review and retain the backup before confirming if any older records may be legitimate.

The administrator **Settings → Reset all browser data** action requires confirmation and removes all current browser records, including accounts. It does not recreate sample content.

## CMU interface and branding

Both member and administrator pages share the CMU palette: navy `#0B2D6B`, gold `#F4B400`, white `#FFFFFF`, and light gray `#F5F7FA`. The original `assets/cmu-logo.png`, matching the supplied university logo, is used without alterations on authentication forms, both dashboards, headers, and the favicon. Its source is documented in `assets/README.md`.

`style.css` owns shared color tokens and layout foundations; `css/final.css` applies the CMU component styles and responsive adaptations. Navigation, forms, tables, equipment and reservation cards, notifications, confirmation dialogs, loading indicators, and charts use the same visual system. Status text and accessible color variations distinguish success, warnings, and errors. Reduced-motion preferences disable the loading animation.

All statistics, charts, lists, and reports continue to derive from existing browser records. This design update adds no sample inventory, accounts, transactions, or backend connection.

## Project files

```text
index.html             Application shell, login and registration forms
style.css              Shared components and responsive layouts
css/final.css          Final visual system, mobile navigation and print layout
script.js              Reservation, approval, borrowing, return and management logic
js/storage.js          Empty initial state, schema handling and relationship adapter
js/reports.js          Transaction-based reports, CSV export and report UI
js/interface.js        Additional views, accessibility, guards and startup
js/qr-workflow.js      Member QR submissions, downloads, camera scanning and image uploads
js/vendor/qrcode.min.js Local QRCode.js dependency
js/vendor/jsQR.js      Pinned jsQR 1.4.0 image decoder
tests/browser-workflow.cjs Browser regression test (Node.js and Chrome; no npm packages)
```

`relationalSnapshot()` exposes derived relational tables for future integration work; it does not connect to or create a MySQL database. Any production use needs a backend, server-side authentication and authorization, secure password hashing, validation, and atomic stock operations.

## Verification

Run `node tests/browser-workflow.cjs` on Windows with Chrome installed. The test starts a temporary local server and headless Chrome with a temporary isolated browser profile. It covers empty initialization, signup, role boundaries, inventory, reservation approval, QR validation, borrowing, returns, reports, persistence, legacy reset, and desktop/tablet/mobile layouts. The test summary is written to `tests/last-run.json`.

The browser checks also cover CMU colors and logo loading, authentication layouts down to 320px, every member and administrator route at six widths, and equipment, condition, approval, rejection, QR, and return-inspection interfaces. Dialog checks verify keyboard focus containment and background isolation. To capture review screenshots on Windows PowerShell, run `$env:CMU_CAPTURE_SCREENSHOTS = '1'` followed by `node tests/browser-workflow.cjs`. Screenshots are stored in the ignored `tests/screenshots/` directory. Test records exist only in the temporary browser profile, which is removed at completion.

QR checks include explicit member sending, admin receipt, actual PNG downloads, PNG/JPG/WebP and screenshot decoding, forged and used-code rejection, storage-failure rollback, and preservation of version 11 records. Camera decoding is exercised using a real canvas video stream as the simulated camera source, including permission-denial and cancellation cases. Physical camera hardware still needs an on-device check.

## Dependency license

`js/vendor/qrcode.min.js` is QRCode.js by David Shim, distributed under the MIT license. See `js/vendor/LICENSE.txt`.

`js/vendor/jsQR.js` is [jsQR 1.4.0](https://github.com/cozmo/jsQR) by Cosmo Wolfe and contributors, distributed under Apache License 2.0. It was downloaded from the pinned npm distribution at `https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js`. See `js/vendor/jsQR-LICENSE.txt`.
