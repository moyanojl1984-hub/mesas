const crypto = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const DISPUTE_MS = 15 * 60 * 1000;
const RATE_LIMIT_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 2;
const MESA_IDS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "B", "C", "D", "ULTRA VIP"]);

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

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
  const now = Date.now();

  if (!MESA_IDS.has(mesaId)) throw new HttpsError("invalid-argument", "Mesa inválida.");
  if (nombre.length < 1 || nombre.length > 60) throw new HttpsError("invalid-argument", "Nombre inválido.");
  if (contacto.length < 5 || contacto.length > 120) throw new HttpsError("invalid-argument", "Contacto inválido.");

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

