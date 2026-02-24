'use strict';

/**
 * @file Router.js
 * @description Dispatches a parsed email message to one or more configured
 * destinations, honouring the `storageOnly` flag set by the FilterEngine.
 *
 * We support six destination types out of the box:
 *   memory     - Write to our in-memory MessageStore (always available).
 *   filesystem - Persist a JSON file to a local directory.
 *   smtp       - Forward to another SMTP server (e.g. a real mail relay).
 *   s3         - Store in an AWS S3 bucket (requires @aws-sdk/client-s3).
 *   azure      - Store in Azure Blob Storage (requires @azure/storage-blob).
 *   gcp        - Store in Google Cloud Storage (requires @google-cloud/storage).
 *
 * The cloud backends are intentionally stubbed out architecturally: we require()
 * the SDK inside the method at call time rather than at module load. This means
 * the app starts up fine without any cloud SDKs installed; you only need to
 * `npm install` the relevant package when you actually configure that destination.
 *
 * We follow the Strategy pattern informally: each `_route*` method is a
 * self-contained "strategy" for a single destination type. Adding a new
 * destination type means adding a new private method and a case in the switch —
 * no other code changes required.
 */

// We use the native fs module for filesystem writes. No extra dependency needed.
const fs = require('fs');

// path.join gives us OS-appropriate separators when building file paths.
const path = require('path');

/**
 * Routes a parsed email message to all applicable destinations.
 * Skips non-storage destinations when `storageOnly` is true (i.e. the
 * FilterEngine decided this recipient shouldn't reach live forwarding targets).
 */
class Router {
  /**
   * Create a Router with an optional reference to the in-memory store.
   *
   * We inject the store rather than requiring it at the module level so that
   * tests can pass in a mock and we can verify that `store.add()` was called
   * with the right arguments.
   *
   * @param {object} [opts={}]
   * @param {import('../smtp/MessageStore')} [opts.store] - The in-memory store (used by 'memory' destinations).
   */
  constructor({ store } = {}) {
    // We keep a private reference to the store. The underscore prefix is our
    // team convention for "don't access this from outside the class".
    this._store = store;
  }

  /**
   * Dispatch `message` to each entry in `destinations`, skipping non-storage
   * destinations when `storageOnly` is true.
   *
   * We process destinations sequentially (for...of with await) rather than
   * in parallel (Promise.all). Sequential processing means that if one
   * destination fails it doesn't cancel the others, and error logs appear in
   * the same order as the destination list — easier to debug.
   *
   * We swallow per-destination errors (log and continue) rather than letting
   * one failing destination block all the others. In a dev tool, it's more
   * important to get the email into memory than to abort everything because
   * S3 credentials are misconfigured.
   *
   * @param {object}   message                - Parsed and ID-stamped email object.
   * @param {object[]} [destinations=[]]      - Destination config objects from RoutingConfig.
   * @param {boolean}  [storageOnly=false]    - When true, skip non-storage destinations.
   * @returns {Promise<string[]>} Names of destination types that successfully received the message.
   */
  async route(message, destinations = [], storageOnly = false) {
    // We accumulate the names of destinations that successfully received the
    // message. The caller (SmtpService) doesn't currently use this, but it's
    // useful for testing and for future observability hooks.
    const routed = [];

    // We iterate over each configured destination in order. Using for...of with
    // await means each destination is attempted one at a time — if we used
    // Promise.all() we'd fire them all in parallel, which is faster but makes
    // errors harder to trace and could cause race conditions in tests.
    for (const dest of destinations) {
      // We check whether this destination type is considered "storage". Storage
      // destinations are always written to; non-storage destinations (like SMTP
      // forwarding) are skipped when the filter says storageOnly = true.
      const isStorage = ['memory', 'filesystem', 's3', 'azure', 'gcp'].includes(dest.type);

      // If the filter restricted this message to storage-only and this destination
      // isn't a storage type, we skip it entirely and move on to the next one.
      if (storageOnly && !isStorage) continue;

      // We wrap each destination attempt in try/catch so that one failing
      // destination doesn't prevent the others from running. We log the error
      // so it's visible in the terminal, then carry on.
      try {
        // We use a switch on dest.type to delegate to the appropriate private
        // method. Each case is intentionally short — all the real logic lives in
        // the `_route*` methods below, keeping this method easy to scan.
        switch (dest.type) {
          case 'memory':
            // We guard against a missing store (e.g. in a test where no store
            // was injected) before calling add() to avoid a null dereference.
            if (this._store) {
              this._store.add(message);
              routed.push('memory');
            }
            break;

          case 'filesystem':
            // We delegate to _routeFilesystem for all the path-building and
            // file-writing logic. We await so that any write error surfaces here.
            await this._routeFilesystem(message, dest);
            routed.push('filesystem');
            break;

          case 'smtp':
            // We delegate SMTP forwarding to _routeSmtp which handles nodemailer
            // setup and address normalisation.
            await this._routeSmtp(message, dest);
            routed.push('smtp');
            break;

          case 's3':
            await this._routeS3(message, dest);
            routed.push('s3');
            break;

          case 'azure':
            await this._routeAzure(message, dest);
            routed.push('azure');
            break;

          case 'gcp':
            await this._routeGcp(message, dest);
            routed.push('gcp');
            break;

          default:
            // We warn rather than throw — an unknown destination type shouldn't
            // crash the whole routing pipeline; we just skip it.
            console.warn(`[router] Unknown destination type: ${dest.type}`);
        }
      } catch (err) {
        // We log the error with the destination type so it's easy to see which
        // backend failed. We don't rethrow because other destinations should
        // still get a chance to receive this message.
        console.error(`[router] Destination "${dest.type}" failed:`, err.message);
      }
    }

    // We return the list of destinations that succeeded. This is primarily
    // useful in tests where we want to assert that exactly the right
    // destinations were written to.
    return routed;
  }

  // ── Destination implementations ─────────────────────────────────────────────
  // Each method below handles one destination type. They're all private
  // (underscore prefix) because they should only ever be called from route().

  // ── Storage path helpers ────────────────────────────────────────────────────

  /**
   * Determine the file extension from the message's content type and body.
   *
   * We check the `content-type` header first (handles xhtml), then fall back
   * to the presence of an html body, then default to plain text.
   *
   * @private
   * @param {object} message - The message object.
   * @returns {string} File extension without leading dot (e.g. 'html', 'xhtml', 'txt').
   */
  _getMimeExtension(message) {
    const ct = message.headers && (message.headers['content-type'] || message.headers['Content-Type']);
    if (ct) {
      const ctStr = typeof ct === 'string' ? ct : (ct.value || '');
      if (/xhtml/i.test(ctStr)) return 'xhtml';
      if (/html/i.test(ctStr)) return 'html';
      if (/plain/i.test(ctStr)) return 'txt';
    }
    if (message.html) return 'html';
    return 'txt';
  }

  /**
   * Format a receivedAt ISO-8601 string as `YYYYMMDD-HHMMSSmmm`.
   *
   * @private
   * @param {string} isoString - ISO-8601 timestamp (e.g. from message.receivedAt).
   * @returns {string} Formatted timestamp (e.g. '20261013-141705001').
   */
  _formatTimestamp(isoString) {
    const d = new Date(isoString);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}`;
    return `${date}-${time}`;
  }

  /**
   * Sanitise a single path segment so it cannot be used for path traversal.
   *
   * We remove any character that is not a letter, digit, hyphen, underscore,
   * or dot, and strip leading dots to prevent hidden-file tricks.  An empty
   * result is replaced with the placeholder `_` so callers always get a
   * non-empty segment.
   *
   * @private
   * @param {string} segment - Raw segment string to sanitise.
   * @returns {string} A filesystem-safe segment.
   */
  _sanitizePathSegment(segment) {
    // Allow only alphanumeric characters, hyphens, and underscores.
    // We intentionally exclude dots to prevent hidden-file tricks and to
    // eliminate all possible path-traversal sequences (e.g. '..' after the
    // leading-dot strip would still contain '..' elsewhere in the string).
    let safe = String(segment).replace(/[^a-zA-Z0-9_-]/g, '_');
    // Strip leading underscores that result from leading non-alphanumeric chars.
    safe = safe.replace(/^_+/, '');
    return safe || '_';
  }

  /**
   * Build the ordered list of path segments for a stored message.
   *
   * The layout is `{email_prefix}/{email_suffix}/{timestamp}.{ext}` when the
   * recipient uses plus-addressing (e.g. `user+tag@domain`), or
   * `{email_prefix}/{timestamp}.{ext}` otherwise.
   *
   * We use the first recipient in `message.to` as the address to derive the
   * directory structure from, matching the problem-statement examples.
   *
   * @private
   * @param {object} message - The message object.
   * @returns {string[]} Path segments, e.g. ['user', 'tag', '20261013-141705001.html'].
   */
  _buildStorageSubpath(message) {
    const recipient = Array.isArray(message.to) ? message.to[0] : message.to;
    const address = (recipient && recipient.address) ? recipient.address : String(recipient || '');
    const localPart = address.split('@')[0];
    const plusIdx = localPart.indexOf('+');
    const prefix = plusIdx >= 0 ? localPart.slice(0, plusIdx) : localPart;
    const suffix = plusIdx >= 0 ? localPart.slice(plusIdx + 1) : null;
    const timestamp = this._formatTimestamp(message.receivedAt);
    const ext = this._getMimeExtension(message);
    const filename = `${timestamp}.${ext}`;
    // We sanitise each segment independently to prevent path traversal through
    // crafted recipient addresses (e.g. "../../etc@domain.com").
    const safePrefix = this._sanitizePathSegment(prefix);
    const safeSuffix = suffix !== null ? this._sanitizePathSegment(suffix) : null;
    return safeSuffix ? [safePrefix, safeSuffix, filename] : [safePrefix, filename];
  }

  /**
   * Return the body content to persist for a message.
   *
   * We prefer the HTML body over plain text so that the stored file matches
   * the extension chosen by `_getMimeExtension`.
   *
   * @private
   * @param {object} message - The message object.
   * @returns {string} The body content to write.
   */
  _getBodyContent(message) {
    return message.html || message.text || '';
  }

  /**
   * Write the message body to the local filesystem under a structured path.
   *
   * The path layout follows `{base}/{email_prefix}/{email_suffix}/{timestamp}.{ext}`
   * (or `{base}/{email_prefix}/{timestamp}.{ext}` for recipients without a `+` tag).
   *
   * @private
   * @param {object} message - The message to persist.
   * @param {object} dest    - Destination config.
   * @param {string} [dest.path='./mail'] - Base directory to write files into.
   * @returns {Promise<void>}
   */
  async _routeFilesystem(message, dest) {
    const base = path.resolve(dest.path || './mail');
    const subpath = this._buildStorageSubpath(message);

    // All segments except the last form the directory; the last is the filename.
    const dir = path.join(base, ...subpath.slice(0, -1));

    // Guard against path traversal: the resolved directory must remain inside
    // the configured base.  With sanitised segments this should always hold, but
    // we verify explicitly as a defence-in-depth measure.
    const resolvedDir = path.resolve(dir);
    if (!resolvedDir.startsWith(base + path.sep) && resolvedDir !== base) {
      throw new Error(`Filesystem destination path escapes base directory: ${resolvedDir}`);
    }

    fs.mkdirSync(dir, { recursive: true });

    const filename = path.join(dir, subpath[subpath.length - 1]);
    fs.writeFileSync(filename, this._getBodyContent(message));
  }

  /**
   * Forward the message via an external SMTP server using nodemailer.
   *
   * We lazy-require nodemailer here (rather than at the top of the file) so
   * that the package is only needed when someone actually configures an SMTP
   * forwarding destination. This keeps our mandatory dependency list lean.
   *
   * @private
   * @param {object} message       - The message to forward.
   * @param {object} dest          - Destination config.
   * @param {string}  dest.host    - SMTP relay hostname.
   * @param {number}  [dest.port=587] - SMTP relay port.
   * @param {boolean} [dest.secure=false] - Use TLS from the start (port 465 style).
   * @param {string}  [dest.user]  - SMTP auth username (optional).
   * @param {string}  [dest.pass]  - SMTP auth password (optional).
   * @returns {Promise<void>}
   */
  async _routeSmtp(message, dest) {
    // We try to require nodemailer here at call-time. If it's not installed
    // we throw a helpful message telling the developer what to run.
    let nodemailer;
    try {
      nodemailer = require('nodemailer');
    } catch {
      throw new Error('nodemailer is required for SMTP forwarding (npm install nodemailer)');
    }

    // We create a fresh transporter for each message rather than caching one.
    // This is slightly less efficient but avoids stale connection issues in
    // long-running processes — fine for a dev tool's volumes.
    const transporter = nodemailer.createTransport({
      host: dest.host,
      port: dest.port || 587,         // 587 is the standard submission port
      secure: dest.secure || false,   // false = STARTTLS upgrade; true = direct TLS
      // We only include auth if a username was configured — some relays are open.
      auth: dest.user ? { user: dest.user, pass: dest.pass } : undefined,
    });

    // Normalise the `to` field: it could be an array of address objects (from
    // mailparser), a plain string, or something in between. We need a single
    // comma-separated string for nodemailer's `to` field.
    const toAddresses = Array.isArray(message.to)
      ? message.to.map((t) => t.address || t).join(', ')
      : String(message.to || '');

    // Similarly, `from` could be an array of address objects. We take the first
    // element (there's typically only one sender) and extract its address string.
    const fromAddress = Array.isArray(message.from)
      ? (message.from[0]?.address || String(message.from[0] || ''))
      : String(message.from || '');

    // We send the mail and await the result. If the relay rejects the message
    // (e.g. auth failure, rate limit) nodemailer will throw and we'll catch it
    // in route()'s try/catch block above.
    await transporter.sendMail({
      from: fromAddress,
      to: toAddresses,
      subject: message.subject,
      // We pass html and text as undefined (not null) when absent because
      // nodemailer handles undefined better than null for optional fields.
      html: message.html || undefined,
      text: message.text || undefined,
    });
  }

  // ── Cloud storage stubs ─────────────────────────────────────────────────────
  // We lazy-require the cloud SDK packages inside each method so that none of
  // them are mandatory at startup — only install what you actually use.

  /**
   * Store the message body in an AWS S3 bucket using the structured key layout.
   *
   * The key layout is `{email_prefix}/{email_suffix}/{timestamp}.{ext}` (or
   * without the suffix segment when the recipient has no `+` tag).  The bucket
   * name itself is the storage basepoint, so no additional prefix is needed.
   *
   * @private
   * @param {object} message              - The message to store.
   * @param {object} dest                 - Destination config.
   * @param {string} dest.bucket          - S3 bucket name.
   * @param {string} [dest.region='us-east-1'] - AWS region.
   * @returns {Promise<void>}
   */
  async _routeS3(message, dest) {
    // We lazy-require the AWS SDK. This throws with a clear message if the
    // package isn't installed, rather than a cryptic MODULE_NOT_FOUND error.
    let S3Client, PutObjectCommand;
    try {
      ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
    } catch {
      throw new Error('Install @aws-sdk/client-s3 to enable S3 routing');
    }

    // We build a new S3 client pointing at the configured region.
    // Credentials are picked up automatically from the environment
    // (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or an IAM role).
    const client = new S3Client({ region: dest.region || 'us-east-1' });

    // Build the structured key: {email_prefix}/{email_suffix}/{timestamp}.{ext}
    const subpath = this._buildStorageSubpath(message);
    const key = subpath.join('/');
    const ext = this._getMimeExtension(message);
    const contentTypeMap = { html: 'text/html', xhtml: 'application/xhtml+xml', txt: 'text/plain' };

    await client.send(new PutObjectCommand({
      Bucket: dest.bucket,
      Key: key,
      Body: this._getBodyContent(message),
      ContentType: contentTypeMap[ext] || 'text/plain',
    }));
  }

  /**
   * Store the message body in Azure Blob Storage using the structured path layout.
   *
   * The blob name follows `{email_prefix}/{email_suffix}/{timestamp}.{ext}` (or
   * without the suffix segment when the recipient has no `+` tag).
   *
   * @private
   * @param {object} message                  - The message to store.
   * @param {object} dest                     - Destination config.
   * @param {string} dest.connectionString    - Azure Storage connection string.
   * @param {string} [dest.container='emails'] - Blob container name.
   * @returns {Promise<void>}
   */
  async _routeAzure(message, dest) {
    let BlobServiceClient;
    try {
      ({ BlobServiceClient } = require('@azure/storage-blob'));
    } catch {
      throw new Error('Install @azure/storage-blob to enable Azure Blob routing');
    }

    // We connect to the Azure account using the connection string from config.
    // fromConnectionString handles all the authentication header construction.
    const serviceClient = BlobServiceClient.fromConnectionString(dest.connectionString);

    // We get (or lazily create) a container client. createIfNotExists() is
    // idempotent — it won't throw if the container already exists.
    const container = serviceClient.getContainerClient(dest.container || 'emails');
    await container.createIfNotExists();

    // Build the structured blob name: {email_prefix}/{email_suffix}/{timestamp}.{ext}
    const subpath = this._buildStorageSubpath(message);
    const blobName = subpath.join('/');
    const ext = this._getMimeExtension(message);
    const contentTypeMap = { html: 'text/html', xhtml: 'application/xhtml+xml', txt: 'text/plain' };
    const blob = container.getBlockBlobClient(blobName);
    const body = this._getBodyContent(message);

    // We pass the byte length explicitly because the Azure SDK requires it for
    // block blob uploads. Buffer.byteLength handles multi-byte characters correctly.
    await blob.upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: contentTypeMap[ext] || 'text/plain' },
    });
  }

  /**
   * Store the message body in a Google Cloud Storage bucket using the structured
   * path layout.
   *
   * The object path follows `{email_prefix}/{email_suffix}/{timestamp}.{ext}` (or
   * without the suffix segment when the recipient has no `+` tag).
   *
   * @private
   * @param {object} message              - The message to store.
   * @param {object} dest                 - Destination config.
   * @param {string} dest.bucket          - GCS bucket name.
   * @returns {Promise<void>}
   */
  async _routeGcp(message, dest) {
    let Storage;
    try {
      ({ Storage } = require('@google-cloud/storage'));
    } catch {
      throw new Error('Install @google-cloud/storage to enable GCP routing');
    }

    // We create a Storage client; credentials are read from the environment
    // (GOOGLE_APPLICATION_CREDENTIALS or Application Default Credentials).
    const gcs = new Storage();

    // Build the structured GCS object path: {email_prefix}/{email_suffix}/{timestamp}.{ext}
    const subpath = this._buildStorageSubpath(message);
    const objectPath = subpath.join('/');
    const ext = this._getMimeExtension(message);
    const contentTypeMap = { html: 'text/html', xhtml: 'application/xhtml+xml', txt: 'text/plain' };
    const file = gcs.bucket(dest.bucket).file(objectPath);

    // file.save() uploads the string body and sets the content type header.
    await file.save(this._getBodyContent(message), { contentType: contentTypeMap[ext] || 'text/plain' });
  }
}

module.exports = Router;
