import nodemailer, { Transporter } from 'nodemailer';
import { logger } from '../utils/logger';

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
  /** When host is an already-resolved IP, the real host name for TLS certificate checks. */
  tls?: { servername: string };
}

export interface EmailOptions {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Port 465 uses implicit TLS; other ports (587, 25) upgrade with STARTTLS.
 * Pass `servername` when `host` is an IP resolved from that name, so the
 * connection goes to the checked address and TLS still verifies the name.
 */
export const buildMailConfig = (
  host: string,
  port: number,
  user: string,
  pass: string,
  servername?: string
): MailConfig => ({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
  ...(servername && servername !== host ? { tls: { servername } } : {}),
});

/** The server's shared SMTP account. */
export const SHARED_SMTP_HOST = process.env.SMTP_HOST || 'smtp.ethereal.email';
export const SHARED_SMTP_USER = process.env.ETHEREAL_USER || '';

const defaultMailConfig = buildMailConfig(
  SHARED_SMTP_HOST,
  parseInt(process.env.SMTP_PORT || '587', 10),
  SHARED_SMTP_USER,
  process.env.ETHEREAL_PASS || ''
);

export const createMailTransporter = (config: MailConfig = defaultMailConfig): Transporter => {
  logger.info(`📧 Mail transporter created for ${config.host}:${config.port}`);
  return nodemailer.createTransport(config);
};

export const defaultTransporter = createMailTransporter();

export const verifyMailConnection = async (transporter: Transporter): Promise<boolean> => {
  try {
    await transporter.verify();
    logger.info('✅ SMTP connection verified successfully');
    return true;
  } catch (error) {
    logger.error('❌ SMTP connection verification failed:', error);
    return false;
  }
};

export const sendEmail = async (
  options: EmailOptions,
  transporter: Transporter = defaultTransporter
): Promise<any> => {
  const info = await transporter.sendMail(options);
  logger.info(`✅ Email sent: ${info.messageId}`);

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    logger.info(`📧 Preview URL: ${previewUrl}`);
  }

  return info;
};
