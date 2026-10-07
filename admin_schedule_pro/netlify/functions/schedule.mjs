import { getStore } from "@netlify/blobs";

const store = getStore("admin-schedule");
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Pragma": "no-cache"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers });

const dateOk = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const hourOk = v => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23;
const profileKey = id => `profile/${encodeURIComponent(id)}`;
const slotKey = (date, hour) => `slot/${date}/${String(hour).padStart(2, "0")}`;
const unavailableKey = (date, id) => `unavailable/${date}/${encodeURIComponent(id)}`;

async function readProfiles() {
  const { blobs } = await store.list({ prefix: "profile/" });
  const profiles = {};
  for (const item of blobs) {
    const value = await store.get(item.key, { type: "json" });
    if (value?.id && value?.name) profiles[value.id] = value.name;
  }
  return profiles;
}

async function readState() {
  const { blobs } = await store.list();
  const profiles = {};
  const slots = {};
  const unavailable = {};

  for (const item of blobs) {
    if (item.key.startsWith("profile/")) {
      const value = await store.get(item.key, { type: "json" });
      if (value?.id && value?.name) profiles[value.id] = value.name;
    }
  }

  for (const item of blobs) {
    if (item.key.startsWith("slot/")) {
      const parts = item.key.split("/");
      const date = parts[1], hour = Number(parts[2]);
      const value = await store.get(item.key, { type: "json" });
      if (dateOk(date) && hourOk(hour) && value?.profileId) {
        if (!slots[date]) slots[date] = {};
        slots[date][String(hour)] = {
          profileId: value.profileId,
          name: profiles[value.profileId] || value.name || "Неизвестный"
        };
      }
    }
    if (item.key.startsWith("unavailable/")) {
      const parts = item.key.split("/");
      const date = parts[1], encodedId = parts.slice(2).join("/");
      const profileId = decodeURIComponent(encodedId);
      const value = await store.get(item.key, { type: "json" });
      if (dateOk(date) && value && profiles[profileId]) {
        if (!unavailable[date]) unavailable[date] = {};
        unavailable[date][profileId] = {
          allDay: Boolean(value.allDay),
          hours: Array.isArray(value.hours) ? value.hours.map(Number).filter(hourOk).sort((a,b) => a-b) : []
        };
      }
    }
  }
  return { profiles, slots, unavailable };
}

async function hasProfile(id) {
  const value = await store.get(profileKey(id), { type: "json" });
  return Boolean(value?.id && value?.name);
}

async function slotValue(date, hour) {
  return store.get(slotKey(date, hour), { type: "json" });
}

async function unavailableValue(date, id) {
  return store.get(unavailableKey(date, id), { type: "json" });
}

export default async function handler(req) {
  try {
    if (req.method === "GET") return json(await readState());
    if (req.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);

    let body;
    try { body = await req.json(); }
    catch { return json({ error: "Неверный JSON" }, 400); }

    if (body.action === "addProfile") {
      const id = String(body.id || "").trim();
      const name = String(body.name || "").trim().slice(0, 30);
      if (!id || !name) return json({ error: "Укажи имя профиля" }, 400);
      const profiles = await readProfiles();
      const existing = Object.entries(profiles).find(([, n]) => String(n).toLowerCase() === name.toLowerCase());
      if (existing) return json({ existing: { id: existing[0], name: existing[1] } });
      await store.setJSON(profileKey(id), { id, name });
      return json({ ok: true, id, name });
    }

    if (body.action === "deleteProfile") {
      const id = String(body.id || "");
      if (!(await hasProfile(id))) return json({ error: "Профиль не найден" }, 404);
      const { blobs } = await store.list();
      for (const item of blobs) {
        if (item.key === profileKey(id)) continue;
        if (item.key.startsWith("slot/")) {
          const v = await store.get(item.key, { type: "json" });
          if (v?.profileId === id) await store.delete(item.key);
        }
        if (item.key.startsWith("unavailable/") && decodeURIComponent(item.key.split("/").slice(2).join("/")) === id) {
          await store.delete(item.key);
        }
      }
      await store.delete(profileKey(id));
      return json({ ok: true });
    }

    if (body.action === "setSlot") {
      const date = String(body.date || ""), hour = Number(body.hour), profileId = String(body.profileId || ""), reserve = Boolean(body.reserve);
      if (!dateOk(date) || !hourOk(hour) || !(await hasProfile(profileId))) return json({ error: "Некорректные данные" }, 400);
      const u = await unavailableValue(date, profileId);
      if (reserve && u && (u.allDay || (u.hours || []).includes(hour))) return json({ error: "Ты отметил это время как недоступное" }, 409);
      const key = slotKey(date, hour);
      const existing = await slotValue(date, hour);
      if (reserve) {
        if (existing && existing.profileId !== profileId) return json({ error: `Час уже выбрал: ${existing.name}` }, 409);
        const profiles = await readProfiles();
        await store.setJSON(key, { profileId, name: profiles[profileId] });
      } else if (existing?.profileId === profileId) {
        await store.delete(key);
      }
      return json({ ok: true, saved: true });
    }

    if (body.action === "setUnavailable") {
      const date = String(body.date || ""), hour = Number(body.hour), profileId = String(body.profileId || ""), reserve = Boolean(body.reserve);
      if (!dateOk(date) || !hourOk(hour) || !(await hasProfile(profileId))) return json({ error: "Некорректные данные" }, 400);
      const key = unavailableKey(date, profileId);
      const current = (await unavailableValue(date, profileId)) || { allDay: false, hours: [] };
      let hours = Array.isArray(current.hours) ? [...current.hours].map(Number) : [];
      if (reserve) {
        if (!hours.includes(hour)) hours.push(hour);
        hours.sort((a,b) => a-b);
        await store.setJSON(key, { allDay: false, hours });
        const existing = await slotValue(date, hour);
        if (existing?.profileId === profileId) await store.delete(slotKey(date, hour));
      } else {
        hours = hours.filter(h => h !== hour);
        if (current.allDay) await store.setJSON(key, { allDay: true, hours });
        else if (hours.length) await store.setJSON(key, { allDay: false, hours });
        else await store.delete(key);
      }
      return json({ ok: true, saved: true });
    }

    if (body.action === "setUnavailableDay") {
      const date = String(body.date || ""), profileId = String(body.profileId || ""), reserve = Boolean(body.reserve);
      if (!dateOk(date) || !(await hasProfile(profileId))) return json({ error: "Некорректные данные" }, 400);
      const key = unavailableKey(date, profileId);
      if (reserve) {
        await store.setJSON(key, { allDay: true, hours: [] });
        const { blobs } = await store.list({ prefix: `slot/${date}/` });
        for (const item of blobs) {
          const v = await store.get(item.key, { type: "json" });
          if (v?.profileId === profileId) await store.delete(item.key);
        }
      } else {
        await store.delete(key);
      }
      return json({ ok: true, saved: true });
    }

    if (body.action === "syncSlots") {
      const profileId = String(body.profileId || ""), operations = Array.isArray(body.operations) ? body.operations : [];
      if (!(await hasProfile(profileId))) return json({ error: "Профиль не найден" }, 400);
      const conflicts = [];
      const profiles = await readProfiles();
      for (const op of operations) {
        const date = String(op.date || ""), hour = Number(op.hour), reserve = Boolean(op.reserve);
        if (!dateOk(date) || !hourOk(hour)) continue;
        const u = await unavailableValue(date, profileId);
        if (reserve && u && (u.allDay || (u.hours || []).includes(hour))) { conflicts.push({ date, hour, name: "Ты отметил недоступность" }); continue; }
        const key = slotKey(date, hour), existing = await slotValue(date, hour);
        if (reserve) {
          if (existing && existing.profileId !== profileId) { conflicts.push({ date, hour, name: existing.name }); continue; }
          await store.setJSON(key, { profileId, name: profiles[profileId] });
        } else if (existing?.profileId === profileId) await store.delete(key);
      }
      return json({ ok: true, saved: true, conflicts });
    }

    return json({ error: "Неизвестное действие" }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: "Ошибка сервера: " + (error?.message || "unknown") }, 500);
  }
}
