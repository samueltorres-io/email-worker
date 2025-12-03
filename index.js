const Redis = require('ioredis');
const nodemailer = require('nodemailer');
const handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');

const requiredEnv = ['REDIS_PASS', 'SMTP_USER', 'SMTP_PASS'];
requiredEnv.forEach(key => {
    if (!process.env[key]) {
        console.error(`CRITICAL ERROR: Variable ${key} not defined!`);
        process.exit(1);
    }
});

/**
 * appendonly yes
 * appendfsync everysec
 * maxmemory-policy noeviction
*/
const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASS
});

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "email-smtp.us-east-1.amazonaws.com",
    port: 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

const MAIN_QUEUE = 'queue:send-email';
const DLQ_QUEUE = 'queue:send-email:dlq';
const MAX_RETRIES_DEFAULT = 3;
const templateCache = {};

function getTemplate(templateName) {
    if (!templateCache[templateName]) {
        try {
            const filePath = path.join(__dirname, 'templates', `${templateName}.hbs`);
            const source = fs.readFileSync(filePath, 'utf8');
            templateCache[templateName] = handlebars.compile(source);
        } catch (e) {
            throw new Error(`Template '${templateName}' not found or invalid!`);
        }
    }
    return templateCache[templateName];
}

async function processQueue() {
    while (true) {
        try {
            const result = await redis.blpop(MAIN_QUEUE, 0);
            if (!result) continue;

            /*
                {
                    "to": "usuario@exemplo.com",
                    "subject": "Bem-vindo",
                    "templateName": "welcome", 
                    "variables": {
                        "name": "Fulano Silva",
                        "confirmationLink": "https://domain/confirm?token=xyz",
                        "year": 2025
                    }
                }
            */
            const payloadRaw = result[1];
            let payload;
            try {
                payload = JSON.parse(payloadRaw);
            } catch (e) {
                await redis.rpush(DLQ_QUEUE, JSON.stringify({ error: "Invalid JSON", raw: payloadRaw, date: new Date() }));
                continue;
            }

            if (typeof payload.attempts === 'undefined') payload.attempts = MAX_RETRIES_DEFAULT;

            /*
                {
                    "to": "user@example.com",
                    "subject": "Oi",
                    "templateName": "welcome",
                    "variables": { ... },
                    "attempts": 3
                }
            */
            const template = getTemplate(String(payload.templateName).trim());
            const htmlToSend = template(payload.variables);

            await transporter.sendMail({
                from: '"company" <no-reply@domain>',
                to: payload.to,
                subject: payload.subject,
                html: htmlToSend
            });

        } catch (error) {
            await handleFailure(error, result ? JSON.parse(result[1]) : null);
        }
    }
}

async function handleFailure(error, payload) {
    if (!payload) return;

    payload.attempts = (payload.attempts || 1) - 1;
    payload.lastError = error.message;
    payload.lastErrorDate = new Date();

    if (payload.attempts > 0) {
        await new Promise(r => setTimeout(r, 5000));
        await redis.rpush(MAIN_QUEUE, JSON.stringify(payload));
    } else {
        await redis.rpush(DLQ_QUEUE, JSON.stringify(payload));
    }
}

// node index.js --retry-dlq
async function retryDLQ() {
    let count = 0;
    
    while (true) {
        const item = await redis.rpop(DLQ_QUEUE);
        if (!item) break;

        const payload = JSON.parse(item);
        
        payload.attempts = MAX_RETRIES_DEFAULT;
        delete payload.lastError;

        await redis.lpush(MAIN_QUEUE, JSON.stringify(payload));
        count++;
        process.stdout.write('.');
    }
    process.exit(0);
}

if (process.argv.includes('--retry-dlq')) {
    retryDLQ();
} else {
    processQueue();
}