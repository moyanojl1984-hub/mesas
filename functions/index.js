const crypto = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const DISPUTE_MS = 15 * 60 * 1000;
const RATE_LIMIT_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 2;
const MESA_IDS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "B", "C", "D", "ULTRA VIP"]);
const twilioAccountSid = defineSecret("TWILIO_ACCOUNT_SID");
const twilioAuthToken = defineSecret("TWILIO_AUTH_TOKEN");
const twilioWhatsappFrom = defineSecret("TWILIO_WHATSAPP_FROM");

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeWhatsapp(value) {
  return String(value || "").replace(/[\s().-]/g, "");
}

function verificationRef(phone) {
  return db.collection("whatsappVerifications").doc(hash(phone));
}

async function sendWhatsappCode(phone, code) {
  const body = new URLSearchParams({
    To: `whatsapp:${phone}`,
    From: `whatsapp:${twilioWhatsappFrom.value()}`,
    Body: `Tu código para reservar en Cubano Bar es: ${code}. Vence en 5 minutos. No lo compartas.`,
  });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid.value()}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${twilioAccountSid.value()}:${twilioAuthToken.value()}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) throw new Error(`Twilio respondió ${response.status}`);
}

exports.requestWhatsappCode = onCall({
  region: "us-central1",
  enforceAppCheck: true,
  consumeAppCheckToken: true,
  secrets: [twilioAccountSid, twilioAuthToken, twilioWhatsappFrom],
}, async (request) => {
  const phone = normalizeWhatsapp(request.data?.contacto);
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new HttpsError("invalid-argument", "Ingresá un número de WhatsApp con código de país.");
  const ref = verificationRef(phone);
  const existing = await ref.get();
  if (existing.exists && Number(existing.data().sentAt) > Date.now() - 60000) {
    throw new HttpsError("resource-exhausted", "Esperá un minuto antes de pedir otro código.");
  }
  const code = String(crypto.randomInt(100000, 1000000));
  const token = crypto.randomBytes(32).toString("hex");
  await sendWhatsappCode(phone, code);
  await ref.set({
    codeHash: hash(`${code}:${token}`),
    tokenHash: hash(token),
    sentAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000,
    attempts: 0,
    verifiedAt: null,
  });
  return { verificationToken: token, expiresAt: Date.now() + 5 * 60 * 1000 };
});

exports.verifyWhatsappCode = onCall({
  region: "us-central1",
  enforceAppCheck: true,
  consumeAppCheckToken: true,
}, async (request) => {
  const phone = normalizeWhatsapp(request.data?.contacto);
  const code = String(request.data?.code || "").trim();
  const token = String(request.data?.verificationToken || "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone) || !/^\d{6}$/.test(code) || token.length < 32) {
    throw new HttpsError("invalid-argument", "Código o teléfono inválido.");
  }
  const ref = verificationRef(phone);
  const snapshot = await ref.get();
  const verification = snapshot.exists ? snapshot.data() : null;
  if (!verification || verification.expiresAt <= Date.now() || verification.attempts >= 5) {
    throw new HttpsError("permission-denied", "El código venció o superó los intentos.");
  }
  if (verification.codeHash !== hash(`${code}:${token}`)) {
    await ref.update({ attempts: (verification.attempts || 0) + 1 });
    throw new HttpsError("permission-denied", "Código incorrecto.");
  }
  await ref.update({ verifiedAt: Date.now() });
  return { verified: true, verificationToken: token };
});

function isActive(reservation, now) {
  if (!reservation) return false;
  if (reservation.status === "disputa" && Number.isInteger(reservation.expiresAt) && reservation.expiresAt <= now) return false;
  return ["pendiente", "disputa", "aprobada", "ocupada", "comprobante_subido", "pendiente_revision", "vendida"].includes(reservation.status);
}

exports.createDispute = onCall({
  region: "us-central1",
  enforceAppCheck: true,
  consumeAppCheckToken: true,
}, async (request) => {
  const data = request.data || {};
  const mesaId = String(data.mesaId || "").trim();
  const nombre = String(data.nombre || "").trim();
  const contacto = normalize(data.contacto);
  const verificationToken = String(data.verificationToken || "");
  const now = Date.now();

  if (!MESA_IDS.has(mesaId)) throw new HttpsError("invalid-argument", "Mesa inválida.");
  if (nombre.length < 1 || nombre.length > 60) throw new HttpsError("invalid-argument", "Nombre inválido.");
  if (!/^\+[1-9]\d{7,14}$/.test(contacto) || verificationToken.length < 32) throw new HttpsError("invalid-argument", "WhatsApp no verificado.");

  const verificationSnapshot = await verificationRef(contacto).get();
  const verification = verificationSnapshot.exists ? verificationSnapshot.data() : null;
  if (!verification || verification.tokenHash !== hash(verificationToken) || !verification.verifiedAt || verification.verifiedAt < now - 15 * 60 * 1000) {
    throw new HttpsError("permission-denied", "Verificá tu WhatsApp antes de reservar.");
  }

  const ip = request.rawRequest?.ip || "unknown";
  const rateLimitId = hash(`${ip}:${contacto}`);
  const rateLimitRef = db.collection("rateLimits").doc(rateLimitId);
  const reservationRef = db.collection("reservas").doc(mesaId);
  const expiresAt = now + DISPUTE_MS;

  try {
    await db.runTransaction(async (transaction) => {
      const [rateLimitSnapshot, reservationSnapshot] = await Promise.all([
        transaction.get(rateLimitRef),
        transaction.get(reservationRef),
      ]);
      const previous = rateLimitSnapshot.exists ? rateLimitSnapshot.data() : {};
      const recentAttempts = Number(previous.windowStartedAt) > now - RATE_LIMIT_MS ? Number(previous.attempts || 0) : 0;
      if (recentAttempts >= RATE_LIMIT_MAX) {
        throw new HttpsError("resource-exhausted", "Límite temporal alcanzado.");
      }
      if (reservationSnapshot.exists && isActive(reservationSnapshot.data(), now)) {
        throw new HttpsError("already-exists", "La mesa ya no está disponible.");
      }

      transaction.set(rateLimitRef, {
        attempts: recentAttempts + 1,
        windowStartedAt: recentAttempts ? previous.windowStartedAt : now,
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(reservationRef, {
        status: "disputa",
        nombre,
        contacto,
        ts: now,
        expiresAt,
        createdBy: "public",
      });
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error("No se pudo crear la disputa", { mesaId, error });
    throw new HttpsError("internal", "No se pudo crear la disputa.");
  }

  return { mesaId, expiresAt };
});

exports.expireDisputes = require("firebase-functions/v2/scheduler").onSchedule("every 5 minutes", async () => {
  const snapshot = await db.collection("reservas")
    .where("status", "==", "disputa")
    .where("expiresAt", "<=", Date.now())
    .limit(100)
    .get();
  if (snapshot.empty) return;
  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  logger.info("Disputas expiradas liberadas", { count: snapshot.size });
});

