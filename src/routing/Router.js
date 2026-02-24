'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Routes a parsed email message to configured destinations.
 *
 * Supported destination types:
 *   memory     - In-memory MessageStore (the default development store).
 *   filesystem - Write JSON file to a local directory.
 *   smtp       - Forward via another SMTP server (e.g. SendGrid).
 *   s3         - AWS S3 (requires @aws-sdk/client-s3).
 *   azure      - Azure Blob Storage (requires @azure/storage-blob).
 *   gcp        - Google Cloud Storage (requires @google-cloud/storage).
 *
 * Cloud backends are wired up architecturally; their SDK packages must be
 * installed separately when credentials are available.
 */
class Router {
  /**
   * @param {object} opts
   * @param {import('../smtp/MessageStore')} [opts.store] - The in-memory store.
   */
  constructor({ store } = {}) {
    this._store = store;
  }

  /**
   * Route a message to all applicable destinations.
   *
   * @param {object}   message       - Parsed email message object.
   * @param {object[]} destinations  - Array of destination config objects.
   * @param {boolean}  storageOnly   - When true, non-storage destinations are skipped.
   * @returns {Promise<string[]>}    Names of destinations that received the message.
   */
  async route(message, destinations = [], storageOnly = false) {
    const routed = [];

    for (const dest of destinations) {
      const isStorage = ['memory', 'filesystem', 's3', 'azure', 'gcp'].includes(dest.type);
      if (storageOnly && !isStorage) continue;

      try {
        switch (dest.type) {
          case 'memory':
            if (this._store) {
              this._store.add(message);
              routed.push('memory');
            }
            break;

          case 'filesystem':
            await this._routeFilesystem(message, dest);
            routed.push('filesystem');
            break;

          case 'smtp':
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
            console.warn(`[router] Unknown destination type: ${dest.type}`);
        }
      } catch (err) {
        console.error(`[router] Destination "${dest.type}" failed:`, err.message);
      }
    }

    return routed;
  }

  // ── Destination implementations ─────────────────────────────────────────────

  async _routeFilesystem(message, dest) {
    const dir = dest.path || './mail';
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.join(dir, `${message.id}.json`);
    fs.writeFileSync(filename, JSON.stringify(message, null, 2));
  }

  async _routeSmtp(message, dest) {
    let nodemailer;
    try {
      nodemailer = require('nodemailer');
    } catch {
      throw new Error('nodemailer is required for SMTP forwarding (npm install nodemailer)');
    }

    const transporter = nodemailer.createTransport({
      host: dest.host,
      port: dest.port || 587,
      secure: dest.secure || false,
      auth: dest.user ? { user: dest.user, pass: dest.pass } : undefined,
    });

    const toAddresses = Array.isArray(message.to)
      ? message.to.map((t) => t.address || t).join(', ')
      : String(message.to || '');

    const fromAddress = Array.isArray(message.from)
      ? (message.from[0]?.address || String(message.from[0] || ''))
      : String(message.from || '');

    await transporter.sendMail({
      from: fromAddress,
      to: toAddresses,
      subject: message.subject,
      html: message.html || undefined,
      text: message.text || undefined,
    });
  }

  // ── Cloud storage stubs ─────────────────────────────────────────────────────
  // These require optional cloud SDK packages to be installed separately.

  async _routeS3(message, dest) {
    let S3Client, PutObjectCommand;
    try {
      ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
    } catch {
      throw new Error('Install @aws-sdk/client-s3 to enable S3 routing');
    }
    const client = new S3Client({ region: dest.region || 'us-east-1' });
    const key = `${dest.prefix || 'emails'}/${message.id}.json`;
    await client.send(new PutObjectCommand({
      Bucket: dest.bucket,
      Key: key,
      Body: JSON.stringify(message),
      ContentType: 'application/json',
    }));
  }

  async _routeAzure(message, dest) {
    let BlobServiceClient;
    try {
      ({ BlobServiceClient } = require('@azure/storage-blob'));
    } catch {
      throw new Error('Install @azure/storage-blob to enable Azure Blob routing');
    }
    const serviceClient = BlobServiceClient.fromConnectionString(dest.connectionString);
    const container = serviceClient.getContainerClient(dest.container || 'emails');
    await container.createIfNotExists();
    const blob = container.getBlockBlobClient(`${message.id}.json`);
    const body = JSON.stringify(message);
    await blob.upload(body, body.length, {
      blobHTTPHeaders: { blobContentType: 'application/json' },
    });
  }

  async _routeGcp(message, dest) {
    let Storage;
    try {
      ({ Storage } = require('@google-cloud/storage'));
    } catch {
      throw new Error('Install @google-cloud/storage to enable GCP routing');
    }
    const gcs = new Storage();
    const file = gcs.bucket(dest.bucket).file(`${dest.prefix || 'emails'}/${message.id}.json`);
    await file.save(JSON.stringify(message), { contentType: 'application/json' });
  }
}

module.exports = Router;
