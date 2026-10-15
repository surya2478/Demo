# Bitbucket approval sync

Approved test cases can be published from **Review & Approval**. A project uses
one repository derived from its PPM ID; each review request owns one file:

```text
<ppm-repository>/test-cases/<request-id>.json
```

Requests with the same PPM therefore accumulate in the same repository. A
resync replaces that request's file with its current approved cases, including
removing cases that are no longer approved.

## Configure

1. Copy `app/bitbucket_config.example.json` to
   `app/bitbucket_config.json`. The runtime file is intentionally ignored by
   Git because it may contain credentials.
2. Set `enabled` to `true`.
3. Select `provider`: `cloud` or `data_center`.
4. For Cloud, set `workspace`. For Data Center, set `project_key` and use the
   server root as `base_url` (for example `https://bitbucket.company.example`).
5. Set authentication:
   - `basic`: username plus app password/API token in `password`.
   - `bearer`: token in `access_token`.
   - `none`: no Authorization header, useful only where anonymous write access
     is explicitly supported.
6. Set proxy mode:
   - `none`: bypass process proxy variables.
   - `environment`: use `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.
   - `url`: use the configured proxy URL. Leave proxy username/password blank
     for an unauthenticated proxy, or set both for an authenticated proxy.

Prefer `${BITBUCKET_...}` placeholders from `.env` instead of literal secrets.
The API reloads the JSON for every sync, so correcting configuration and
pressing **Resync** does not require a restart.

## Behaviour

- Existing PPM repository: reuse it.
- Missing PPM repository: create it, then commit the request JSON.
- Bitbucket failure: keep the approval, record a failed sync, and show Retry.
- Successful sync: store the repository URL, commit hash, content hash, actor,
  timestamp, and attempt count.
- Concurrent sync: reject the duplicate. A sync left stale by a process crash
  becomes retryable after ten minutes.

The service follows the official repository-create and file-commit REST APIs
for Bitbucket Cloud and Bitbucket Data Center.
