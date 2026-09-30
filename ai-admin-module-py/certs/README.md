# Company CA certificates

Put the internal CA certificates here as PEM files ending in `.crt` — the
**root** and any **intermediate** that issued `dx12348.etisalat.corp.ae`.
The Dockerfile adds every `*.crt` in this folder to the image's trusted
certificates, so the backend's calls to the AI service (AI Checks, refine,
healing, KB generation) verify the same way the browser does.

These are public CA certificates, not secrets — safe to commit.

Getting them: in Edge/Chrome open https://dx12348.etisalat.corp.ae/qatlas →
padlock → Certificate → Details → Certificate Hierarchy → select the top entry
(root) → Export → Base-64 encoded ASCII. Repeat for the middle entry. Save as
`etisalat-root-ca.crt` and `etisalat-intermediate-ca.crt`.

Check a file is PEM: it starts with `-----BEGIN CERTIFICATE-----`.
