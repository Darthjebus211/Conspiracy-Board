/**
 * Conspiracy Board — a shared clue board for Foundry VTT v14.
 *
 * Clue cards are Drawings flagged by this module, in three types (Major, Minor,
 * Comment) that differ in text size and card colour. Each card can link to a journal
 * entry or page. String links live in a scene flag and are drawn live on an overlay,
 * so they follow the cards as they move and only join cards visible on the current
 * Scene Level.
 *
 * Players may pin cards and tie strings; those changes are sent to the active GM, who
 * saves them, so players don't need permission over the whole scene.
 */
const MOD = "conspiracy-board";
const SOCKET = `module.${MOD}`;

/** Built-in palette and text sizes, used before the settings are read. */
const CARD_DEFAULTS = {
  major:   { label: "Major",   fontSize: 34, color: "#f4ecb8" },
  minor:   { label: "Minor",   fontSize: 24, color: "#f7cfd6" },
  comment: { label: "Comment", fontSize: 16, color: "#cfe1f0" }
};
const CARD_TYPES = foundry.utils.deepClone(CARD_DEFAULTS);


let linkMode = false;
let pendingCard = null;
let gfx = null;
let redrawQueued = false;
let portraitLayer = null;
/** Sprite + caption per portrait card, keyed by drawing id. */
const portraitCache = new Map();

/** Layout of a portrait card: padding round the picture and the caption strip below it. */
/** Size of a standalone pin's (invisible) drawing, which is its click target. */
const PIN_SIZE = 28;

const PORTRAIT = { width: 180, pad: 8, caption: 28, minHeight: 120, maxHeight: 260 };

/* ---------------------------------- Helpers ---------------------------------- */

/** The Scene Level the local user is viewing, if the scene uses levels. */
const currentLevelId = () => canvas.level?.id ?? null;

/** Read the per-type colours out of the module settings. */
function loadCardTypes() {
  for (const [key, type] of Object.entries(CARD_DEFAULTS)) {
    CARD_TYPES[key] = { ...type, color: String(game.settings.get(MOD, `color_${key}`) || type.color) };
  }
}

const isPortrait = (d) => (d?.document ?? d)?.getFlag?.(MOD, "kind") === "portrait";
const isPin = (d) => (d?.document ?? d)?.getFlag?.(MOD, "kind") === "pin";
const isCard = (d) => !!(d?.document ?? d)?.getFlag?.(MOD, "card");
const getLinks = (scene) => foundry.utils.deepClone(scene?.getFlag(MOD, "links") ?? []);
const hex = (str, fallback) => {
  const n = parseInt(String(str ?? "").replace("#", ""), 16);
  return Number.isNaN(n) ? fallback : n;
};

/**
 * Size a card's box around its text: wide enough for short clues, and tall enough
 * for long ones to wrap without spilling, up to a ceiling.
 */
function cardShape(text, type) {
  const { fontSize } = type;
  const width = Math.round(Math.max(150, Math.min(420, text.length * fontSize * 0.55 + 40)));
  const perLine = Math.max(1, Math.floor((width - 40) / (fontSize * 0.55)));
  const lines = Math.max(1, Math.ceil(text.length / perLine));
  const height = Math.max(54, Math.round(lines * fontSize * 1.3 + 18));
  return { width, height };
}

/** Route a board change through the active GM, who owns the shared state. */
async function request(action, data) {
  if (game.user.isGM) return handle(action, data, game.user.id).catch((err) => console.error(`${MOD} |`, err));
  if (!game.users.activeGM) {
    ui.notifications.warn("Conspiracy Board: a GM must be online to change the board.");
    return;
  }
  game.socket.emit(SOCKET, { action, data });
}

/** Whether a user may link a journal (entry or page) to a card. */
async function canLinkJournal(uuid, user, trusted) {
  if (!uuid) return true;
  const doc = await fromUuid(uuid);
  if (!doc || !["JournalEntry", "JournalEntryPage"].includes(doc.documentName)) return false;
  return trusted || doc.testUserPermission(user, "LIMITED");
}

/** Apply a board change. Requests from players arrive over the socket and are checked
 * here: the sender's real id is used rather than one from the message, the action must
 * be one players may ask for, and journal links are checked against the journal's own
 * permissions (hands out LIMITED access).
 */
async function handle(action, data, userId) {
  const scene = game.scenes.get(data.sceneId);
  if (!scene) return;
  const requester = game.users.get(userId);
  if (!requester) return;
  const trusted = requester.isGM;

  switch (action) {
    case "createCard": {
      const text = String(data.text ?? "").trim().slice(0, 80);
      if (!text) return;
      const x = Number(data.x), y = Number(data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const journal = data.journalUuid || null;
      if (!(await canLinkJournal(journal, requester, trusted))) return;
      const kind = CARD_TYPES[data.kind] ? data.kind : "minor";
      const type = CARD_TYPES[kind];
      const { width, height } = cardShape(text, type);
      await scene.createEmbeddedDocuments("Drawing", [{
        author: userId,
        x: Math.round(x - width / 2),
        y: Math.round(y - height / 2),
        shape: { type: "r", width, height },
        fillType: 1,                    // solid fill; the card's colour comes from its type
        fillColor: type.color,
        fillAlpha: 1,
        strokeWidth: 2,
        strokeColor: "#5a4a2a",
        strokeAlpha: 1,
        text,
        fontFamily: "Signika",
        fontSize: type.fontSize,
        textColor: "#1e1e1e",
        textAlpha: 1,
        ...(data.levelId ? { levels: [data.levelId] } : {}),
        flags: { [MOD]: { card: true, journal, kind } }
      }]);
      break;
    }
    case "createPortrait": {
      const x = Number(data.x), y = Number(data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const actor = await fromUuid(String(data.actorUuid ?? ""));
      if (!actor || actor.documentName !== "Actor") return;
      // Players may only pin art of actors they're allowed to see.
      if (!trusted && !actor.testUserPermission(requester, "LIMITED")) return;
      let img = actor.img;
      const tokenSrc = actor.prototypeToken?.texture?.src;
      if (data.art === "token" && tokenSrc && !tokenSrc.includes("*")) img = tokenSrc; // wildcard tokens fall back to the portrait
      if (!img) return;
      const journal = data.journalUuid || null;
      if (!(await canLinkJournal(journal, requester, trusted))) return;
      const caption = (String(data.caption ?? "").trim() || actor.name || "").slice(0, 80);

      // Fit the card to the art's shape.
      let artHeight = PORTRAIT.width;
      try {
        const tex = await foundry.canvas.loadTexture(img);
        if (tex?.width && tex?.height) artHeight = PORTRAIT.width * tex.height / tex.width;
      } catch (err) { /* unreadable image: keep a square card */ }
      artHeight = Math.round(Math.min(PORTRAIT.maxHeight, Math.max(PORTRAIT.minHeight, artHeight)));
      const width = PORTRAIT.width + PORTRAIT.pad * 2;
      const height = artHeight + PORTRAIT.pad * 2 + PORTRAIT.caption;

      await scene.createEmbeddedDocuments("Drawing", [{
        author: userId,
        x: Math.round(x - width / 2),
        y: Math.round(y - height / 2),
        shape: { type: "r", width, height },
        fillType: 1,
        fillColor: "#fbf8ef",            // white photo border
        fillAlpha: 1,
        strokeWidth: 2,
        strokeColor: "#5a4a2a",
        strokeAlpha: 1,
        text: "",                        // the caption is drawn under the picture by this module
        ...(data.levelId ? { levels: [data.levelId] } : {}),
        flags: { [MOD]: { card: true, kind: "portrait", actor: actor.uuid, img, caption, journal } }
      }]);
      break;
    }
    case "createPin": {
      const x = Number(data.x), y = Number(data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      await scene.createEmbeddedDocuments("Drawing", [{
        author: userId,
        x: Math.round(x - PIN_SIZE / 2),
        y: Math.round(y - PIN_SIZE / 2),
        shape: { type: "r", width: PIN_SIZE, height: PIN_SIZE },
        fillType: 1,
        fillColor: "#000000",
        fillAlpha: 0.01,                 // effectively invisible, but still clickable
        strokeWidth: 0,
        strokeAlpha: 0,
        text: "",
        ...(data.levelId ? { levels: [data.levelId] } : {}),
        flags: { [MOD]: { card: true, kind: "pin", journal: null } }
      }]);
      break;
    }
    case "toggleLink": {
      const { a, b } = data;
      if (!a || !b || a === b) return;
      if (!isCard(scene.drawings.get(a)) || !isCard(scene.drawings.get(b))) return;
      const links = getLinks(scene);
      const i = links.findIndex((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
      if (i >= 0) links.splice(i, 1);
      else links.push({ id: foundry.utils.randomID(), a, b });
      await scene.setFlag(MOD, "links", links);
      break;
    }
    case "removeLinksFor": {
      const links = getLinks(scene).filter((l) => l.a !== data.id && l.b !== data.id);
      await scene.setFlag(MOD, "links", links);
      break;
    }
    case "setJournal": {
      const card = scene.drawings.get(data.id);
      if (!card || !isCard(card)) return;
      const uuid = data.journalUuid || null;
      // Only a GM may link an entry the requester isn't allowed to see.
      if (!(await canLinkJournal(uuid, requester, trusted))) return;
      await card.setFlag(MOD, "journal", uuid);
      break;
    }
    case "renameCard": {
      const card = scene.drawings.get(data.id);
      if (!card || !isCard(card) || isPin(card)) return;
      // Players may only name a blank clue (adopting its journal's name); GMs may rename any.
      if (!trusted && String(isPortrait(card) ? card.getFlag(MOD, "caption") ?? "" : card.text ?? "").trim()) return;
      const text = String(data.text ?? "").trim().slice(0, 80);
      if (!text) break;
      if (isPortrait(card)) await card.setFlag(MOD, "caption", text);
      else await card.update({ text });
      break;
    }
    case "recolorKind": {
      if (!trusted) return;
      const kind = CARD_TYPES[data.kind] ? data.kind : null;
      if (!kind) return;
      const color = String(data.color ?? CARD_TYPES[kind].color);
      const cards = scene.drawings.filter((d) => d.getFlag(MOD, "kind") === kind && d.fillColor !== color);
      if (cards.length) {
        await scene.updateEmbeddedDocuments("Drawing", cards.map((d) => ({ _id: d.id, fillColor: color })));
      }
      break;
    }
    case "clearLinks": {
      if (!trusted) return; // cutting the whole board is the GM's call alone
      await scene.setFlag(MOD, "links", []);
      break;
    }
  }
}

/* ---------------------------------- Actions ---------------------------------- */

/** <option> list of journals and pages the current user can see. */
function journalOptions(selected = "") {
  const esc = (t) => foundry.utils.escapeHTML?.(t) ?? t;
  const opt = (uuid, label) => `<option value="${uuid}"${uuid === selected ? " selected" : ""}>${label}</option>`;
  const visible = (doc) => doc.testUserPermission(game.user, "LIMITED");
  return game.journal.filter(visible)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((j) => opt(j.uuid, esc(j.name)) + j.pages
      .filter(visible)
      .map((p) => opt(p.uuid, "&nbsp;&nbsp;↳ " + esc(p.name))).join(""))
    .join("");
}

/** The words shown on a card: its text, or a portrait's caption. */
const cardLabel = (card) => String((isPortrait(card)
  ? (card.document ?? card).getFlag(MOD, "caption")
  : (card.document ?? card).text) ?? "");

/** Link (or change / remove) the journal of the selected clue. */
async function promptLinkJournal(card) {
  card ??= canvas.drawings.controlled.find(isCard);
  if (!card) return ui.notifications.warn("Conspiracy Board: select a clue first.");
  const current = card.document.getFlag(MOD, "journal") ?? "";
  const known = !current || !!fromUuidSync(current);
  const content = `
    <p><strong>${foundry.utils.escapeHTML?.(cardLabel(card)) ?? cardLabel(card)}</strong></p>
    <div class="form-group"><label>Linked journal</label>
      <select name="journal">
        <option value="">— none —</option>
        ${known ? "" : `<option value="${current}" selected>(missing or hidden entry)</option>`}
        ${journalOptions(current)}
      </select></div>`;
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Link a Journal to this Clue" },
    content,
    ok: { label: "Save", callback: (event, button) => ({ journalUuid: button.form.elements.journal.value }) },
    rejectClose: false
  });
  if (!result || !canvas.scene) return;
  await request("setJournal", { sceneId: canvas.scene.id, id: card.id, journalUuid: result.journalUuid });

  // A clue with no text of its own adopts the journal's name. The card may belong to
  // someone else, so the rename is asked of the GM rather than written here.
  if (result.journalUuid && !isPin(card) && !cardLabel(card).trim()) {
    const doc = fromUuidSync(result.journalUuid) ?? await fromUuid(result.journalUuid);
    const name = doc?.name?.trim();
    if (name) await request("renameCard", { sceneId: canvas.scene.id, id: card.id, text: name });
  }

  ui.notifications.info(result.journalUuid ? "Conspiracy Board: journal linked." : "Conspiracy Board: journal link removed.");
}

async function promptNewCard() {
  if (!canvas.scene) return;
  const options = journalOptions();
  const typeOptions = Object.entries(CARD_TYPES)
    .map(([k, v]) => `<option value="${k}"${k === "minor" ? " selected" : ""}>${v.label}</option>`)
    .join("");

  const content = `
    <div class="form-group"><label>Type</label>
      <select name="kind">${typeOptions}</select></div>
    <div class="form-group"><label>Clue text</label>
      <input type="text" name="text" maxlength="80" placeholder="e.g. Who paid the ferryman?" autofocus></div>
    <div class="form-group"><label>Linked journal</label>
      <select name="journal"><option value="">— none —</option>${options}</select></div>`;

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Pin a New Clue" },
    content,
    ok: {
      label: "Pin it",
      callback: async (event, button) => {
        const journalUuid = button.form.elements.journal.value;
        let text = button.form.elements.text.value.trim();
        // No title typed: use the linked entry's name, once the uuid resolves.
        if (!text && journalUuid) {
          let doc = fromUuidSync(journalUuid);
          if (!doc) {
            ui.notifications.info("Conspiracy Board: naming the clue after its journal…");
            doc = await fromUuid(journalUuid);
          }
          text = doc?.name?.trim() ?? "";
        }
        if (!text) {
          ui.notifications.warn("Conspiracy Board: give the clue some text or link a journal first.");
          return false;
        }
        return { text, journalUuid, kind: button.form.elements.kind.value };
      }
    },
    rejectClose: false
  });
  if (!result?.text) return;

  const { x, y } = canvas.stage.pivot; // centre of the current view
  await request("createCard", { sceneId: canvas.scene.id, x, y, levelId: currentLevelId(), ...result });
}

/** Pin an actor's portrait or token art as a clue. */
async function promptNewPortrait() {
  if (!canvas.scene) return;
  const esc = (t) => foundry.utils.escapeHTML?.(t) ?? t;
  const actors = game.actors.filter((a) => a.img && a.testUserPermission(game.user, "LIMITED"))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!actors.length) return ui.notifications.warn("Conspiracy Board: there are no actors you can see.");
  const actorOptions = actors.map((a) => `<option value="${a.uuid}">${esc(a.name)}</option>`).join("");

  const content = `
    <div class="form-group"><label>Character</label>
      <select name="actor">${actorOptions}</select></div>
    <div class="form-group"><label>Art</label>
      <select name="art"><option value="portrait" selected>Portrait</option><option value="token">Token</option></select></div>
    <div class="form-group"><label>Caption</label>
      <input type="text" name="caption" maxlength="80" placeholder="Leave blank to use the character's name"></div>
    <div class="form-group"><label>Linked journal</label>
      <select name="journal"><option value="">— none —</option>${journalOptions()}</select></div>`;

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Pin a Character" },
    content,
    ok: {
      label: "Pin it",
      callback: (event, button) => {
        const f = button.form.elements;
        return { actorUuid: f.actor.value, art: f.art.value, caption: f.caption.value.trim(), journalUuid: f.journal.value };
      }
    },
    rejectClose: false
  });
  if (!result?.actorUuid || !canvas.scene) return;
  const { x, y } = canvas.stage.pivot;
  await request("createPortrait", { sceneId: canvas.scene.id, x, y, levelId: currentLevelId(), ...result });
}

/** Open the actor behind a portrait clue, if the user may see it. */
async function openActor(uuid) {
  const actor = uuid ? await fromUuid(uuid) : null;
  if (!actor) return ui.notifications.warn("Conspiracy Board: that character no longer exists.");
  if (!actor.testUserPermission(game.user, "LIMITED")) {
    return ui.notifications.warn("Conspiracy Board: you can't view that character.");
  }
  actor.sheet.render(true);
}

async function openJournal(uuid) {
  const doc = await fromUuid(uuid);
  if (!doc) return ui.notifications.warn("Conspiracy Board: that journal entry no longer exists.");
  if (!doc.testUserPermission(game.user, "LIMITED")) {
    return ui.notifications.warn("Conspiracy Board: you can't view that journal entry.");
  }
  if (doc.documentName === "JournalEntryPage") doc.parent.sheet.render(true, { pageId: doc.id });
  else doc.sheet.render(true);
}

function setLinkMode(active) {
  linkMode = !!active;
  if (linkMode && ui.controls.tool?.name !== "select") {
    ui.controls.activate({ control: "drawings", tool: "select" });
  }
  pendingCard = null;
  ui.notifications.info(linkMode
    ? "Link mode on: click one clue, then another, to tie string between them (repeat to cut it)."
    : "Link mode off.");
}

/** Repaint the clues already on the canvas after a colour setting changes. */
function applyColorsToScene() {
  if (!canvas?.scene) return;
  if (game.user === game.users.activeGM) {
    // The GM saves the change, so the new colour survives a reload and reaches everyone.
    const updates = canvas.scene.drawings
      .filter((d) => isCard(d) && !isPortrait(d) && d.fillColor !== CARD_TYPES[typeKey(d)]?.color)
      .map((d) => ({ _id: d.id, fillColor: CARD_TYPES[typeKey(d)].color }));
    if (updates.length) canvas.scene.updateEmbeddedDocuments("Drawing", updates);
  }
  for (const obj of canvas.drawings?.placeables ?? []) {
    if (isCard(obj) && !isPortrait(obj) && !isPin(obj)) obj.renderFlags?.set({ refresh: true });
  }
  queueRedraw();
}

/** Which type key a card's flag names. */
function typeKey(doc) {
  return CARD_TYPES[(doc?.document ?? doc)?.getFlag?.(MOD, "kind")] ? (doc.document ?? doc).getFlag(MOD, "kind") : "minor";
}

/* --------------------------------- Rendering --------------------------------- */

/** Current anchor for a card: the "pin" at its top centre (top-left corner for comments), following a drag preview. */
function anchorFor(id) {
  const obj = canvas.drawings?.get(id);
  if (!obj || !obj.visible) return null;
  const preview = canvas.drawings.preview?.children?.find((c) => c._original?.id === id);
  const doc = (preview ?? obj).document;
  // Comment clues have small text, so their pin sits on the top-left corner, clear of it.
  if (isPin(doc)) return { x: doc.x + doc.shape.width / 2, y: doc.y + doc.shape.height / 2 };
  if (typeKey(doc) === "comment") return { x: doc.x + 4, y: doc.y + 4 };
  return { x: doc.x + (doc.shape.width / 2), y: doc.y + 14 };
}

const overlayAlive = (g) => !!g && !g.destroyed && !!g.transform && !!g.parent && g._cbOverlay === true;

function queueRedraw() {
  if (redrawQueued) return;
  if (!canvas?.ready || !canvas.scene) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; drawBoard(); });
}

/** Keep a picture and caption on every visible portrait card, following drag previews. */
function syncPortraits() {
  if (!portraitLayer || portraitLayer.destroyed) return;
  const seen = new Set();
  for (const d of canvas.drawings?.placeables ?? []) {
    if (!isPortrait(d) || !d.visible) continue;
    const preview = canvas.drawings.preview?.children?.find((c) => c._original?.id === d.id);
    const doc = (preview ?? d).document;
    const src = doc.getFlag(MOD, "img");
    if (!src) continue;
    seen.add(d.id);

    let entry = portraitCache.get(d.id);
    if (!entry) {
      entry = {
        src: null,
        sprite: new PIXI.Sprite(PIXI.Texture.EMPTY),
        label: new PIXI.Text("", { fontFamily: "Signika", fontSize: 18, fill: 0x1e1e1e, align: "center" })
      };
      entry.label.resolution = 2;
      entry.label.anchor.set(0.5);
      portraitLayer.addChild(entry.sprite, entry.label);
      portraitCache.set(d.id, entry);
    }
    if (entry.src !== src) {
      entry.src = src;
      entry.sprite.texture = PIXI.Texture.EMPTY;
      foundry.canvas.loadTexture(src).then((tex) => {
        if (tex && entry.src === src && !entry.sprite.destroyed) { entry.sprite.texture = tex; queueRedraw(); }
      }).catch(() => {});
    }

    // Fit the art inside the white border, above the caption strip.
    const { width: w, height: h } = doc.shape;
    const { pad, caption } = PORTRAIT;
    const areaW = Math.max(1, w - pad * 2);
    const areaH = Math.max(1, h - pad * 2 - caption);
    const tex = entry.sprite.texture;
    if (tex !== PIXI.Texture.EMPTY && tex.width && tex.height) {
      const scale = Math.min(areaW / tex.width, areaH / tex.height);
      entry.sprite.width = tex.width * scale;
      entry.sprite.height = tex.height * scale;
      entry.sprite.position.set(doc.x + pad + (areaW - entry.sprite.width) / 2, doc.y + pad + (areaH - entry.sprite.height) / 2);
      entry.sprite.visible = true;
    } else entry.sprite.visible = false;

    const text = String(doc.getFlag(MOD, "caption") ?? "");
    if (entry.label.text !== text) entry.label.text = text;
    entry.label.scale.set(1);
    if (entry.label.width > areaW) entry.label.scale.set(areaW / entry.label.width);
    entry.label.position.set(doc.x + w / 2, doc.y + h - pad - caption / 2);
  }
  for (const [id, entry] of portraitCache) {
    if (seen.has(id)) continue;
    entry.sprite.destroy();   // the texture is shared through Foundry's cache, so it stays
    entry.label.destroy();
    portraitCache.delete(id);
  }
}

function drawBoard() {
  if (!overlayAlive(gfx) || !canvas.scene) return;
  syncPortraits();
  gfx.clear();
  const color = hex(game.settings.get(MOD, "stringColor"), 0xb3141b);
  const sag = Number(game.settings.get(MOD, "stringSag")) || 0;

  for (const link of getLinks(canvas.scene)) {
    const a = anchorFor(link.a);
    const b = anchorFor(link.b);
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 + sag;
    gfx.lineStyle(5, 0x000000, 0.25).moveTo(a.x + 2, a.y + 3).quadraticCurveTo(mx + 2, my + 3, b.x + 2, b.y + 3);
    gfx.lineStyle(3, color, 0.95).moveTo(a.x, a.y).quadraticCurveTo(mx, my, b.x, b.y);
  }

  // The pin on every card.
  gfx.lineStyle(0);
  for (const d of canvas.drawings.placeables.filter(isCard)) {
    const p = anchorFor(d.id);
    if (!p) continue;
    const pending = d.id === pendingCard;
    gfx.beginFill(0x000000, 0.3).drawCircle(p.x + 2, p.y + 2, 8).endFill();
    gfx.beginFill(pending ? 0xffd200 : 0xd11f1f).drawCircle(p.x, p.y, 8).endFill();
    gfx.beginFill(0xffffff, 0.6).drawCircle(p.x - 2.5, p.y - 2.5, 2.5).endFill();
  }
}

/* ----------------------------------- Hooks ----------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MOD, "stringColor", {
    name: "String colour", hint: "Colour of the string linking clues.",
    scope: "world", config: true,
    type: new foundry.data.fields.ColorField({ default: "#b3141b", nullable: false }),
    onChange: queueRedraw
  });
  game.settings.register(MOD, "stringSag", {
    name: "String sag", hint: "How far the string droops between pins, in pixels.",
    scope: "world", config: true, type: Number,
    range: { min: 0, max: 200, step: 5 }, default: 40,
    onChange: queueRedraw
  });
  for (const [key, type] of Object.entries(CARD_DEFAULTS)) {
    game.settings.register(MOD, `color_${key}`, {
      name: `${type.label} clue colour`,
      hint: `Background of ${type.label.toLowerCase()} clues (${type.fontSize}px text).`,
      scope: "world", config: true,
      type: new foundry.data.fields.ColorField({ default: type.color, nullable: false }),
      onChange: () => { loadCardTypes(); applyColorsToScene(); }
    });
  }

  // Double-click a clue opens its journal; shift+double-click opens the drawing config.
  const original = foundry.canvas.placeables.Drawing.prototype._onClickLeft2;
  foundry.canvas.placeables.Drawing.prototype._onClickLeft2 = function (event) {
    const uuid = this.document.getFlag(MOD, "journal");
    if (isCard(this) && !event?.shiftKey) {
      if (uuid) return openJournal(uuid);
      if (isPortrait(this)) return openActor(this.document.getFlag(MOD, "actor"));
      return promptLinkJournal(this);
    }
    return original.call(this, event);
  };

  game.keybindings.register(MOD, "linkJournal", {
    name: "Link journal to selected clue",
    editable: [{ key: "KeyJ" }],
    onDown: () => {
      if (!canvas.drawings?.active || !canvas.drawings.controlled.some(isCard)) return false;
      promptLinkJournal();
      return true;
    }
  });
});

Hooks.once("ready", () => {
  loadCardTypes();
  // The second argument is the sender id supplied by the server, so it can't be spoofed.
  game.socket.on(SOCKET, (message, senderId) => {
    if (game.user !== game.users.activeGM) return;
    const { action, data } = message ?? {};
    if (!senderId || !data) return;
    handle(action, data, senderId).catch((err) => console.error(`${MOD} |`, err));
  });
  game.modules.get(MOD).api = {
    createCard: (text, journalUuid, x, y, kind = "minor") => request("createCard", {
      sceneId: canvas.scene.id, levelId: currentLevelId(), kind, text, journalUuid,
      x: x ?? canvas.stage.pivot.x, y: y ?? canvas.stage.pivot.y
    }),
    createPortrait: (actorUuid, { art = "portrait", caption = "", journalUuid = null, x, y } = {}) => request("createPortrait", {
      sceneId: canvas.scene.id, levelId: currentLevelId(), actorUuid, art, caption, journalUuid,
      x: x ?? canvas.stage.pivot.x, y: y ?? canvas.stage.pivot.y
    }),
    createPin: (x, y) => request("createPin", {
      sceneId: canvas.scene.id, levelId: currentLevelId(),
      x: x ?? canvas.stage.pivot.x, y: y ?? canvas.stage.pivot.y
    }),
    linkJournal: (cardId, journalUuid) => request("setJournal", { sceneId: canvas.scene.id, id: cardId, journalUuid }),
    toggleLink: (a, b) => request("toggleLink", { sceneId: canvas.scene.id, a, b }),
    clearLinks: () => request("clearLinks", { sceneId: canvas.scene.id }),
    redraw: queueRedraw
  };
});

Hooks.on("canvasReady", () => {
  if (overlayAlive(gfx)) gfx.destroy();
  gfx = new PIXI.Graphics();
  gfx.eventMode = "none";
  gfx._cbOverlay = true;
  portraitLayer?.destroy?.({ children: true });
  portraitCache.clear();
  portraitLayer = new PIXI.Container();
  portraitLayer.eventMode = "none";
  canvas.interface.addChild(portraitLayer, gfx); // pictures under the strings and pins
  pendingCard = null;
  queueRedraw();
});

// Tear the overlay down with the canvas, so the next scene builds a fresh one rather
// than reusing graphics whose base texture has been freed.
Hooks.on("canvasTearDown", () => {
  try {
    gfx?.destroy?.({ children: true, texture: false });
  } catch (err) {
    // Already gone; nothing to do.
  }
  gfx = null;
  try {
    portraitLayer?.destroy?.({ children: true });
  } catch (err) {
    // Already gone.
  }
  portraitLayer = null;
  portraitCache.clear();
  redrawQueued = false;
});

Hooks.on("canvasLevelChange", queueRedraw);
Hooks.on("sightRefresh", queueRedraw);

for (const hook of ["refreshDrawing", "createDrawing", "updateDrawing", "destroyDrawing"]) {
  Hooks.on(hook, queueRedraw);
}

Hooks.on("updateScene", (scene, changes) => {
  if (scene.id === canvas.scene?.id && foundry.utils.hasProperty(changes, `flags.${MOD}`)) queueRedraw();
});

Hooks.on("deleteDrawing", (doc) => {
  queueRedraw();
  if (isCard(doc) && game.user === game.users.activeGM) {
    handle("removeLinksFor", { sceneId: doc.parent.id, id: doc.id }, game.user.id);
  }
});

// Link mode: picking one card and then another ties them together.
Hooks.on("controlDrawing", (drawing, controlled) => {
  if (!linkMode || !controlled || !isCard(drawing)) return;
  if (!pendingCard || !canvas.drawings.get(pendingCard)) {
    pendingCard = drawing.id;
  } else if (pendingCard !== drawing.id) {
    const other = canvas.drawings.get(pendingCard);
    if (!other || !isCard(other)) { pendingCard = drawing.id; queueRedraw(); return; }
    request("toggleLink", { sceneId: canvas.scene.id, a: pendingCard, b: drawing.id });
    pendingCard = null;
    setTimeout(() => canvas.drawings.releaseAll(), 0);
  }
  queueRedraw();
});

// Board tools live in Foundry's own Drawing controls, which can select drawings.
Hooks.on("getSceneControlButtons", (controls) => {
  const drawings = controls.drawings;
  if (!drawings) return;
  const base = 100;
  Object.assign(drawings.tools, {
    cbAddClue: { name: "cbAddClue", order: base + 1, title: "Conspiracy Board: pin a new clue",
      icon: "fa-solid fa-thumbtack", button: true, onChange: () => promptNewCard() },
    cbAddPortrait: { name: "cbAddPortrait", order: base + 1.5, title: "Conspiracy Board: pin a character's art",
      icon: "fa-solid fa-user-secret", button: true, onChange: () => promptNewPortrait() },
    cbAddPin: { name: "cbAddPin", order: base + 1.75, title: "Conspiracy Board: place a lone pin (centre of view)",
      icon: "fa-solid fa-location-pin", button: true,
      onChange: () => canvas.scene && request("createPin", {
        sceneId: canvas.scene.id, levelId: currentLevelId(), x: canvas.stage.pivot.x, y: canvas.stage.pivot.y
      }) },
    cbJournal: { name: "cbJournal", order: base + 2, title: "Conspiracy Board: link a journal to the selected clue",
      icon: "fa-solid fa-book-open", button: true, onChange: () => promptLinkJournal() },
    cbLink: { name: "cbLink", order: base + 3, title: "Conspiracy Board: link mode (tie string)",
      icon: "fa-solid fa-diagram-project", toggle: true, active: linkMode,
      onChange: (event, active) => setLinkMode(active) },
    cbClear: { name: "cbClear", order: base + 4, title: "Conspiracy Board: cut all strings on this scene",
      icon: "fa-solid fa-scissors", button: true, visible: game.user.isGM,
      onChange: () => canvas.scene && request("clearLinks", { sceneId: canvas.scene.id }) }
  });
});

// Link mode needs the Select tool, so it stands down when another control is picked,
// and the button it stands down from is un-pressed to match.
Hooks.on("renderSceneControls", () => {
  if (linkMode && ui.controls.control?.name !== "drawings") {
    linkMode = false;
    pendingCard = null;
    const tool = ui.controls.control?.tools?.cbLink;
    if (tool) tool.active = false;
    queueRedraw();
  }
});
