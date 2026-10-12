# Certify

Create, approve and issue certificates without paperwork.

## Run it

```
npm install
npm start
```

Open http://localhost:3000 and sign in as **admin / admin123**. Change this password in **My Profile** straight away.

## How it works

1. **Templates.** Start from a ready-made design for your purpose: course completion, academic merit, training, internship, appreciation, employee of the month, competition winner, workshop, webinar, sports or volunteering. Then adjust the style, colours, logo and wording. Any `{{word}}` you put in the text (for example `{{course}}` or `{{date}}`) becomes a column you fill in for each recipient. The live preview shows exactly what will be printed.
   - **Signatures:** the approver's signature is added automatically on approval. You can also add up to two more fixed signatories by drawing a signature, uploading an image, or using your own saved one.
   - **Stamps & seals:** upload your organisation's real stamp or seal from your computer or phone, or use a built-in gold award seal, round rubber stamp with curved text, or rectangular "APPROVED"-style stamp. Each one has its own position, size, rotation, opacity and fine-position controls.
   - **Uploading images:** stamps, signatures and logos can be uploaded by clicking to browse, dragging a file in, pasting an image (Ctrl+V), or taking a photo on a phone. The upload window can remove a paper background (with a strength slider) and trim empty margins, and shows a preview before you use the image. Uploaded images are saved to a shared library, so they can be reused in other templates without uploading them again.
   - **Writing help:** a built-in checker flags common spelling mistakes, repeated words, broken `{{placeholders}}` and punctuation, with one-click fixes. If an AI key is configured, **Write with AI** drafts three wording options for your purpose and tone, **Check grammar** proofreads the text, and **Rewrite** makes it more formal, shorter, warmer and so on.
2. **Batches.** Create a batch and choose its template, filtered by purpose. Then paste rows copied from Excel or Google Sheets, or drop in a CSV file. Columns are matched by header name. **Tidy names** fixes spacing and capitalisation (for example "aarav SHARMA" becomes "Aarav Sharma") and flags duplicates.
3. **Approval.** The creator submits the batch. An approver previews it, then either approves it or sends it back with a note. Approving stamps the approver's saved signature on every certificate, so nothing needs to be signed by hand.
4. **Issue.** Download one merged PDF for printing, a ZIP of individual PDFs, or a single certificate.
5. **Verify.** Every certificate has a unique ID and a QR code that links to `/verify/<id>`. Anyone can check that it is genuine there. Approvers can revoke a certificate if needed.

## Roles (managed under **Users**)

| Role     | Can do |
|----------|--------|
| Creator  | Create templates and batches, and submit them for approval |
| Approver | Approve or send back batches, and revoke certificates |
| Admin    | Everything, including managing users |

## Settings

| Variable     | Purpose |
|--------------|---------|
| `PORT`       | Port to listen on (default `3000`) |
| `PUBLIC_URL` | Address encoded in the QR codes, e.g. `https://certs.example.org`. Set this when you host the app so the QR codes work for other people. Without it, QR codes use this computer's local network address, so they only open on phones connected to the same Wi-Fi. |
| `ANTHROPIC_API_KEY` | Turns on the AI writing assistant (get a key at console.anthropic.com). Without it, the built-in writing check still works. |
| `CERTIFY_AI_MODEL` | Optional. The Claude model the assistant uses (default `claude-opus-5-5`). |

To start the app with the AI assistant on Windows PowerShell:

```
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm start
```

All data is stored in `data/certify.db` (SQLite). Back up that file to back up everything.

## Notes

- Certificates use the standard PDF fonts, which cover Latin-script names (including accented letters). Names in other scripts, such as Devanagari, would need an embedded Unicode font.
- Once a batch is approved, its design and signature are frozen. Editing the template later never changes certificates that have already been issued.
