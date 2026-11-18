import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Workaround for __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const parseTemplate = (templateName: string, placeholders: { [key: string]: any }): string => {
    const templatePath = path.join(__dirname, '../email-templates', `${templateName}.html`);
    let template = fs.readFileSync(templatePath, 'utf-8');

    // Replace placeholders in the template safely
    Object.keys(placeholders).forEach((key) => {
        const rawValue = placeholders[key];
        const safeValue =
          rawValue === undefined || rawValue === null || rawValue === 'undefined' || rawValue === 'null'
            ? ''
            : String(rawValue);
        const regex = new RegExp(`{{${key}}}`, 'g');
        template = template.replace(regex, safeValue);
    });

    return template;
};
