import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

let transporter: Transporter | null = null;

function buildTransport(): Transporter | null {
  if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) return null;
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
}

export function isMailerReady(): boolean {
  return !!(config.smtp.host && config.smtp.user && config.smtp.pass);
}

export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  if (!isMailerReady()) throw new Error('SMTP_NOT_CONFIGURED');
  if (!transporter) transporter = buildTransport();
  if (!transporter) throw new Error('SMTP_NOT_CONFIGURED');

  const from = config.smtp.fromName
    ? `"${config.smtp.fromName}" <${config.smtp.from}>`
    : config.smtp.from;

  const subject = `MarkSync 注册验证码：${code}`;
  const text = `你的 MarkSync 注册验证码是 ${code}，5 分钟内有效。如果不是你本人操作，请忽略此邮件。`;
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 20px;color:#1f2937;">
  <div style="text-align:center;margin-bottom:24px;">
    <h2 style="margin:0;color:#667eea;">MarkSync 书签同步</h2>
  </div>
  <div style="background:#f7f9fc;border-radius:12px;padding:28px;border:1px solid #e5e7eb;">
    <p style="margin:0 0 12px;font-size:15px;">你好，</p>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.7;">
      你正在申请注册 MarkSync 账号。请使用下面的验证码完成注册：
    </p>
    <div style="text-align:center;margin:24px 0;">
      <div style="display:inline-block;font-size:32px;font-weight:700;letter-spacing:8px;background:#fff;padding:16px 28px;border-radius:8px;border:1px solid #e5e7eb;color:#667eea;">
        ${code}
      </div>
    </div>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;line-height:1.6;">
      验证码 <strong>5 分钟</strong> 内有效，请勿泄露给他人。
    </p>
    <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
      如果不是你本人操作，请忽略此邮件。
    </p>
  </div>
  <div style="text-align:center;color:#9ca3af;font-size:12px;margin-top:20px;">
    此邮件由系统自动发送，请勿回复。
  </div>
</div>`;

  await transporter.sendMail({ from, to, subject, text, html });
}
