import type { EmailRecipient } from '../types';

// The local part allows letters, digits and _ ' + - with single dots between
// them: the same set the backend accepts (so `+` tags work, but nothing the
// server would reject). The domain needs a dot; labels can't start or end with -.
const LOCAL_CHARS = "[A-Za-z0-9_'+-]";
const LOCAL = `${LOCAL_CHARS}+(?:\\.${LOCAL_CHARS}+)*`;
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const DOMAIN = `${LABEL}(?:\\.${LABEL})*\\.[A-Za-z]{2,}`;

// (?<!') : like the backend, the character before @ can't be an apostrophe.
const EMAIL_EXACT = new RegExp(`^${LOCAL}(?<!')@${DOMAIN}$`);
// When extracting from free text, an address must not be glued to other address characters.
const EMAIL_IN_TEXT = new RegExp(
  `(?<![A-Za-z0-9_'+.-])${LOCAL}(?<!')@${DOMAIN}(?![A-Za-z0-9-])`,
  'g'
);

export const validateEmail = (email: string): boolean => EMAIL_EXACT.test(email.trim());

const defaultName = (email: string) => email.split('@')[0];

/** Keep the first occurrence of each address, compared case-insensitively. */
export const dedupeRecipients = (recipients: EmailRecipient[]): EmailRecipient[] => {
  const seen = new Set<string>();
  return recipients.filter((recipient) => {
    const key = recipient.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Extract every email address from free text (typed or pasted). */
export const parseEmails = (text: string): EmailRecipient[] => {
  const matches = text.match(EMAIL_IN_TEXT) ?? [];
  return dedupeRecipients(
    matches.map((match) => {
      const email = match.toLowerCase();
      return { email, name: defaultName(email) };
    })
  );
};

/** Split one CSV line on , ; or tab, honouring "quoted, fields" and "" escapes. */
const splitCsvLine = (line: string): string[] => {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',' || char === ';' || char === '\t') {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
};

/** Parse recipients from CSV/TXT text: one per line, with an optional name column. */
export const parseRecipientsText = (text: string): EmailRecipient[] => {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim());

  const recipients: EmailRecipient[] = [];

  for (const line of lines) {
    const parts = splitCsvLine(line);
    const emailIndex = parts.findIndex(validateEmail);

    if (emailIndex === -1) {
      // A header row or free text: take any addresses it contains.
      recipients.push(...parseEmails(line));
      continue;
    }

    const email = parts[emailIndex].toLowerCase();
    const name = parts.find((part, index) => index !== emailIndex && part.length > 0);
    recipients.push({ email, name: name || defaultName(email) });
  }

  return dedupeRecipients(recipients);
};

export const parseCSV = (file: File): Promise<EmailRecipient[]> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const recipients = parseRecipientsText(String(reader.result ?? ''));
        if (recipients.length === 0) {
          reject(new Error('No valid email addresses found in file'));
        } else {
          resolve(recipients);
        }
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
