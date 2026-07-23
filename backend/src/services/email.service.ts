import nodemailer from 'nodemailer';
import config from '../config';
import logger from '../utils/logger';

let transporter: nodemailer.Transporter | null = null;

/** Escape HTML to prevent injection via displayName / username in emails */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTransporter(): nodemailer.Transporter | null {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
    });
  }
  return transporter;
}

export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  const transport = getTransporter();

  if (!transport) {
    if (config.env === 'production') {
      // Never dump password-reset / verification links into production logs
      logger.error(
        `[email] SMTP not configured — cannot deliver mail to ${options.to} (${options.subject})`
      );
      // Callers that can proceed without mail (e.g. register) must catch this.
      // Forgot-password already fires-and-forgets so the client is not blocked.
      throw new Error('Email delivery is not configured');
    }
    logger.info(`[email:dev] To: ${options.to} | Subject: ${options.subject}`);
    logger.info(`[email:dev] Body: ${options.text || options.html}`);
    return;
  }

  // Hard timeout — a hung SMTP connection used to leave "Forgot password" spinning forever
  const SEND_TIMEOUT_MS = 12_000;
  await Promise.race([
    transport.sendMail({
      from: config.smtp.from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Email send timed out')), SEND_TIMEOUT_MS);
    }),
  ]);
}

export async function sendVerificationEmail(
  email: string,
  token: string,
  username: string
): Promise<void> {
  const url = `${config.clientUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const safeName = escapeHtml(username);
  const safeUrl = escapeHtml(url);
  await sendEmail({
    to: email,
    subject: 'Verify your Pulse account',
    text: `Hi ${username}, verify your email: ${url}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0a84ff;">Welcome to Pulse</h2>
        <p>Hi ${safeName},</p>
        <p>Please verify your email address to activate your account.</p>
        <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:#0a84ff;color:#fff;border-radius:12px;text-decoration:none;font-weight:600;">
          Verify Email
        </a>
        <p style="color:#888;font-size:13px;margin-top:24px;">Or copy this link: ${safeUrl}</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(
  email: string,
  token: string,
  username: string
): Promise<void> {
  const url = `${config.clientUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const safeName = escapeHtml(username);
  const safeUrl = escapeHtml(url);
  await sendEmail({
    to: email,
    subject: 'Reset your Pulse password',
    text: `Hi ${username}, reset your password: ${url}`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0a84ff;">Password Reset</h2>
        <p>Hi ${safeName},</p>
        <p>Click below to reset your password. This link expires in 1 hour.</p>
        <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:#0a84ff;color:#fff;border-radius:12px;text-decoration:none;font-weight:600;">
          Reset Password
        </a>
        <p style="color:#888;font-size:13px;margin-top:24px;">If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}
