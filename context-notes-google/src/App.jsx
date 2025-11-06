
import React, { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { Search, MapPin, Bell, Plus, Trash2, CheckCircle2, NotebookPen, ListTodo, Brain } from "lucide-react";
import * as chrono from "chrono-node";
import { fetchNearbyPOIs } from "./hooks/usePlaces";

/** Config **/
const LS_KEY = "ctxnotes.state.v2";
const DEFAULT_RADIUS_M = 250;
const GEOFENCE_COOLDOWN_MS = 10 * 60 * 1000; // 10 min
const SNOOZE_DEFAULT_MS = 60 * 60 * 1000;    // 1 hour

const nowISO = () => new Date().toISOString();

/** Small helpers **/
function haversineDistanceMeters(a, b) {
  const R = 6371e3;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lng - a.lng);
  const s = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  return R * c;
}
function useLocalStorageState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : (typeof initial === "function" ? initial() : initial);
    } catch { return typeof initial === "function" ? initial() : initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }, [key, value]);
  return [value, setValue];
}
function ensureNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission !== "denied") Notification.requestPermission();
  return Notification.permission === "granted";
}
function notify(title, body) { if (ensureNotificationPermission()) try { new Notification(title, { body }); } catch {} }

/** Simple action rules + checkbox lines extraction **/
const ACTION_MAP = [
  { label: "Return package", category: "returns", patterns: [/\breturn (?:the )?(?:amazon|package|item|parcel)\b/i, /\bdrop off (?:amazon|package)\b/i] },
  { label: "Mail letter", category: "mail", patterns: [/\bmail (?:the )?(?:letter|check|forms?)\b/i, /\bpost (?:a )?letter\b/i] },
  { label: "Pick up food", category: "errands", patterns: [/\bpick (?:up|\s*\-) (?:pizza|food|order)\b/i] },
  { label: "Buy groceries", category: "groceries", patterns: [/\bbuy (?:some )?groceries\b/i, /\bgrocery (?:run|shopping)\b/i] },
  { label: "Call someone", category: "general", patterns: [/\bcall (?:mom|dad|\w+)\b/i] },
  { label: "Pay bill", category: "general", patterns: [/\bpay (?:the )?(?:bill|credit card|rent|utilities)\b/i] },
  { label: "Schedule appointment", category: "general", patterns: [/\b(schedule|book) (?:a )?(?:doctor|dentist|meeting|appointment)\b/i] },
];
function detectActionItems(text) {
  const hits = [];
  for (const rule of ACTION_MAP) {
    for (const p of rule.patterns) {
      const m = (text||"").match(p);
      if (m) { hits.push({ label: rule.label, span: m[0], category: rule.category }); break; }
    }
  }
  for (const ln of (text||"").split(/\n|\r/)) {
    const todo = ln.match(/^\s*\[( |x|X)\]\s*(.+)$/);
    if (todo) hits.push({ label: todo[2], span: todo[0], category: "general" });
  }
  const seen = new Set(); return hits.filter(h => (seen.has(h.label+h.span+h.category)? false : (seen.add(h.label+h.span+h.category), true)));
}
function getAllPendingActions(notes) {
  const actions = [];
  for (const n of notes) {
    const hits = detectActionItems(n.content||"");
    for (const h of hits) actions.push({ ...h, noteId: n.id, noteTitle: n.title });
  }
  return actions;
}
function hasReturnAction(actions) {
  return actions.some(a => a.category === "returns" || /return .*amazon|package|locker/i.test(a.span));
}

/** User behavior model (per POI+category) **/
function loadModel() { try { return JSON.parse(localStorage.getItem("ctxnotes.model.v1") || "{}"); } catch { return {}; } }
function saveModel(m) { try { localStorage.setItem("ctxnotes.model.v1", JSON.stringify(m)); } catch {} }
function shouldNudge(model, poiId, category) {
  const k = `${poiId}::${category}`;
  const pref = model[k]; const now = Date.now();
  if (!pref) return true;
  if (pref.snoozeUntil && now < pref.snoozeUntil) return false;
  if (pref.lastPromptAt && now - pref.lastPromptAt < GEOFENCE_COOLDOWN_MS) return false;
  const accept = pref.acceptCount || 0, dismiss = pref.dismissCount || 0;
  if (dismiss >= 2 && accept === 0) return false;
  return true;
}
function recordNudge(model, poiId, category, event) {
  const k = `${poiId}::${category}`;
  const next = { ...(model[k] || { acceptCount:0, dismissCount:0 }) };
  next.lastPromptAt = Date.now();
  if (event === "accept") next.acceptCount++;
  if (event === "dismiss") next.dismissCount++;
  if (event === "snooze")  next.snoozeUntil = Date.now() + SNOOZE_DEFAULT_MS;
  model[k] = next; saveModel(model);
}

/** Main App **/
export default function App(){
  const [state, setState] = useLocalStorageState(LS_KEY, seedState);
  const [query, setQuery] = useState("");
  const [radiusM, setRadiusM] = useState(DEFAULT_RADIUS_M);
  const [geo, setGeo] = useState(null);
  const [activeSuggestion, setActiveSuggestion] = useState(null);
  const [nearbyPOIs, setNearbyPOIs] = useState([]);

  const modelRef = useRef(loadModel());

  const notesInNotebook = useMemo(() => state.notes.filter(n => n.notebookId===state.ui.selectedNotebookId).sort((a,b)=> new Date(b.updatedAt)-new Date(a.updatedAt)), [state]);
  const filteredNotes = useMemo(()=>{
    const q = query.trim().toLowerCase();
    if(!q) return notesInNotebook;
    return notesInNotebook.filter(n => (n.title+" "+n.content).toLowerCase().includes(q));
  }, [notesInNotebook, query]);
  const selectedNote = useMemo(()=> state.notes.find(n=> n.id===state.ui.selectedNoteId) || filteredNotes[0] || null, [state, filteredNotes]);
  const items = useMemo(()=> detectActionItems(selectedNote?.content || ""), [selectedNote?.content]);

  // Geolocation: watch user position
  useEffect(()=>{
    let watchId = null;
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude }));
      watchId = navigator.geolocation.watchPosition(pos => setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude }), ()=>{}, { enableHighAccuracy:true, maximumAge:10000, timeout:20000 });
    }
    return ()=> { if (watchId && navigator.geolocation) navigator.geolocation.clearWatch(watchId); };
  }, []);

  // Fetch live POIs from Google Places whenever position changes
  useEffect(()=>{
    if (!geo || !import.meta.env.VITE_GOOGLE_MAPS_API_KEY) return;
    (async () => {
      try {
        const pois = await fetchNearbyPOIs(geo.lat, geo.lng, 800);
        setNearbyPOIs(pois);
      } catch (e) {
        console.warn("Places fetch failed:", e);
      }
    })();
  }, [geo]);

  // Proactive nudge logic: anchors -> buddies (returns) if we have pending return actions
  useEffect(()=>{
    if (!geo) return;
    const actions = getAllPendingActions(state.notes);
    if (!hasReturnAction(actions)) return;

    // Detect anchors in live POIs near user
    const NEAR_M = 150;
    const anchors = nearbyPOIs
      .filter(p => p.cat.startsWith("anchor_"))
      .map(p => ({ p, d: haversineDistanceMeters(geo, { lat: p.lat, lng: p.lng }) }))
      .filter(x => x.d <= NEAR_M)
      .sort((a,b)=> a.d - b.d);

    if (!anchors.length) return;

    // Find nearest returns buddy
    const buddies = nearbyPOIs
      .filter(p => p.cat === "returns")
      .map(p => ({ p, d: haversineDistanceMeters(geo, { lat: p.lat, lng: p.lng }) }))
      .sort((a,b)=> a.d - b.d);

    if (!buddies.length) return;
    const best = buddies[0];

    if (!shouldNudge(modelRef.current, best.p.id, "returns")) return;

    setActiveSuggestion({
      label: "Return package",
      category: "returns",
      message: `You're near ${anchors[0].p.name}. Amazon return spot nearby: ${best.p.name}. Return it now?`,
      poi: best.p,
      distance: Math.round(best.d),
      meta: { anchor: anchors[0].p.name }
    });
    recordNudge(modelRef.current, best.p.id, "returns", "prompt");
  }, [geo, nearbyPOIs, state.notes]);

  // Reminder ticker
  useEffect(()=>{
    const tick = () => {
      const now = Date.now();
      const due = state.reminders.filter(r => !r.done && new Date(r.whenISO).getTime() <= now);
      if (due.length) {
        for (const r of due) notify("Reminder", r.text);
        setState(s => ({ ...s, reminders: s.reminders.map(r => (due.some(d => d.id===r.id) ? { ...r, done: true } : r)) }));
      }
    };
    const id = setInterval(tick, 15000);
    return ()=> clearInterval(id);
  }, [state.reminders, setState]);

  /** CRUD **/
  function createNotebook(){
    const id = uuid();
    setState(s => ({ ...s, notebooks: [...s.notebooks, { id, name: `Notebook ${s.notebooks.length+1}` }], ui: { ...s.ui, selectedNotebookId: id, selectedNoteId: null } }));
  }
  function createNote(){
    const id = uuid();
    const note = { id, notebookId: state.ui.selectedNotebookId, title: "Untitled", content: "", createdAt: nowISO(), updatedAt: nowISO() };
    setState(s => ({ ...s, notes: [note, ...s.notes], ui: { ...s.ui, selectedNoteId: id } }));
  }
  function deleteNote(id){
    setState(s => ({ ...s, notes: s.notes.filter(n=> n.id!==id), ui: { ...s.ui, selectedNoteId: s.ui.selectedNoteId===id? null : s.ui.selectedNoteId } }));
  }
  function updateNote(patch){
    setState(s => ({ ...s, notes: s.notes.map(n => (n.id===patch.id? { ...n, ...patch, updatedAt: nowISO() } : n)) }));
  }
  function addReminder(text, whenISO, noteId){
    const r = { id: uuid(), text, whenISO, noteId, done: false };
    setState(s => ({ ...s, reminders: [...s.reminders, r] }));
    notify("Reminder scheduled", text);
  }
  function toggleTodoLine(){
    const ta = document.getElementById("editor");
    if (!selectedNote || !ta) return;
    const { selectionStart, selectionEnd, value } = ta;
    const before = value.slice(0, selectionStart);
    const after = value.slice(selectionEnd);
    const currentLineStart = before.lastIndexOf("\n") + 1;
    const nextBreak = after.indexOf("\n");
    const currentLineEnd = selectionEnd + (nextBreak === -1 ? 0 : nextBreak);
    const line = value.slice(currentLineStart, currentLineEnd === selectionEnd - 1 ? value.length : currentLineEnd + 1);
    const toggled = line
      .replace(/^\s*$/, "[ ] ")
      .replace(/^\s*(?!\[).*/, (m)=> `[ ] ${m}`)
      .replace(/^\s*\[ \]\s+\[x\]\s+/i, "[ ] ")
      .replace(/^\s*\[x\]\s+/i, "[ ] ")
      .replace(/^\s*\[ \]\s+/, "[x] ");
    const newVal = value.slice(0, currentLineStart) + toggled + value.slice(currentLineStart + line.length);
    updateNote({ id: selectedNote.id, content: newVal });
  }

  return (
    <div className="h-screen w-full bg-neutral-50 text-neutral-900 flex">
      {/* Sidebar */}
      <aside className="w-64 border-r bg-white p-3 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <NotebookPen className="w-5 h-5" />
          <h1 className="font-semibold">Notebooks</h1>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-2 rounded-xl border bg-white hover:bg-neutral-50 inline-flex items-center w-full" onClick={createNotebook}>
            <span className="inline-flex items-center"><MapPin className="w-4 h-4 mr-2 opacity-70"/>New Notebook</span>
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {state.notebooks.map(nb => (
            <div key={nb.id} className={`p-2 border rounded mb-2 cursor-pointer ${state.ui.selectedNotebookId===nb.id? "ring-2 ring-neutral-900":""}`} onClick={()=> setState(s=> ({...s, ui: {...s.ui, selectedNotebookId: nb.id}}))}>
              {nb.name}
            </div>
          ))}
        </div>

        <div className="border rounded-2xl p-3 bg-white">
          <div className="font-medium mb-2 flex items-center gap-2"><Brain className="w-4 h-4"/> Context Engine</div>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-neutral-700">
              <MapPin className="w-4 h-4"/> Radius
              <input type="number" className="px-3 py-2 border rounded-xl bg-white w-24" value={radiusM} onChange={(e)=> setRadiusM(Number(e.target.value)||DEFAULT_RADIUS_M)} />
              <span>m</span>
            </div>
            <div className="text-xs">
              {geo ? (<div>📍 {geo.lat.toFixed(5)}, {geo.lng.toFixed(5)}</div>) : (<div className="italic text-neutral-500">Location unavailable</div>)}
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 grid grid-cols-[360px_1fr]">
        {/* Notes list */}
        <div className="border-r bg-white h-full flex flex-col">
          <div className="p-3 flex gap-2 border-b">
            <div className="relative w-full">
              <Search className="absolute left-2 top-2.5 w-4 h-4 text-neutral-400"/>
              <input className="pl-8 px-3 py-2 border rounded-xl bg-white w-full" placeholder="Search notes…" value={query} onChange={(e)=> setQuery(e.target.value)} />
            </div>
            <button className="px-3 py-2 rounded-xl border bg-white hover:bg-neutral-50 inline-flex items-center" onClick={createNote}>
              <Plus className="w-4 h-4 mr-2"/> Note
            </button>
          </div>
          <div className="flex-1 overflow-auto">
            {filteredNotes.map(n => (
              <div key={n.id} className={`p-3 border-b cursor-pointer hover:bg-neutral-50 ${state.ui.selectedNoteId===n.id? "bg-neutral-100" : ""}`} onClick={()=> setState(s=> ({...s, ui: {...s.ui, selectedNoteId: n.id}}))}>
                <div className="flex justify-between items-center">
                  <div className="font-medium truncate max-w-[240px]">{n.title || "Untitled"}</div>
                  <div className="text-xs text-neutral-500">{new Date(n.updatedAt).toLocaleString()}</div>
                </div>
                <div className="text-xs text-neutral-600 line-clamp-2">{n.content || "(empty)"}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Editor & Intelligence */}
        <div className="h-full overflow-auto p-4">
          {selectedNote ? (
            <div className="max-w-4xl mx-auto space-y-4">
              <div className="flex items-center gap-2">
                <input className="text-xl font-semibold px-3 py-2 border rounded-xl bg-white w-full" value={selectedNote.title} onChange={(e)=> updateNote({ id: selectedNote.id, title: e.target.value })} />
                <div className="ml-auto flex gap-2">
                  <button className="px-3 py-2 rounded-xl border bg-white hover:bg-neutral-50 inline-flex items-center" onClick={toggleTodoLine}><ListTodo className="w-4 h-4 mr-1"/> Toggle Todo</button>
                  <button className="px-3 py-2 rounded-xl border border-red-300 text-red-700 bg-white hover:bg-red-50 inline-flex items-center" onClick={()=> deleteNote(selectedNote.id)}><Trash2 className="w-4 h-4 mr-1"/> Delete</button>
                </div>
              </div>

              <Editor note={selectedNote} onChange={(v)=> updateNote({ id: selectedNote.id, content: v })} />

              <div className="grid md:grid-cols-2 gap-4">
                <div className="border rounded-2xl p-3 bg-white">
                  <div className="font-medium mb-2 flex items-center gap-2"><Brain className="w-4 h-4"/> Detected Action Items</div>
                  <div className="space-y-2">
                    {items.length ? items.map((it, idx)=> (
                      <div key={idx} className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4"/>
                        <div className="text-sm">
                          <div className="font-medium">{it.label}</div>
                          <div className="text-neutral-600 text-xs">“{it.span}” • {it.category}</div>
                        </div>
                      </div>
                    )) : <div className="text-sm text-neutral-500">No action items found yet.</div>}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-white">
                  <div className="font-medium mb-2 flex items-center gap-2"><MapPin className="w-4 h-4"/> Smart Suggestions</div>
                  <div className="space-y-3">
                    {activeSuggestion ? (
                      <SuggestionView suggestion={activeSuggestion} onAddReminder={(text, whenISO)=> addReminder(text, whenISO, selectedNote.id)} />
                    ) : (
                      <div className="text-sm text-neutral-500">Suggestions appear when you have an actionable note and we detect a relevant nearby location.</div>
                    )}

                    <div className="pt-2 border-t">
                      <div className="text-xs text-neutral-600 mb-2">Nearby Places</div>
                      <div className="space-y-1 max-h-40 overflow-auto pr-1">
                        {nearbyPOIs.slice(0, 8).map(p => (
                          <div key={p.id} className="text-xs flex items-center gap-2">
                            <MapPin className="w-3.5 h-3.5 opacity-70"/> {p.name}
                            <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full border">{p.cat}</span>
                          </div>
                        ))}
                        {nearbyPOIs.length===0 && <div className="text-xs text-neutral-500">No places found yet…</div>}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full grid place-items-center text-neutral-500">Select or create a note to begin.</div>
          )}
        </div>
      </main>
    </div>
  );
}

/** Editor **/
function Editor({ note, onChange }){
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-xs text-neutral-600">
        <span className="inline-flex items-center px-2 py-1 rounded-full border">Created {new Date(note.createdAt).toLocaleString()}</span>
        <span className="inline-flex items-center px-2 py-1 rounded-full border">Updated {new Date(note.updatedAt).toLocaleString()}</span>
        <div className="ml-auto flex items-center gap-2"><span className="opacity-60">Markdown-style checkboxes: [ ] task / [x] done</span></div>
      </div>
      <textarea id="editor" value={note.content} onChange={(e)=> onChange(e.target.value)} className="min-h-[280px] font-mono px-3 py-2 border rounded-xl bg-white w-full" placeholder={`Jot your thoughts…

Examples:
- return Amazon package
- [ ] pay credit card bill
- [ ] schedule dentist appointment`} />
      <Preview content={note.content} />
    </div>
  );
}

/** Preview **/
function Preview({ content }){
  const lines = (content||"").split(/\n|\r/);
  return (
    <div className="mt-3 border rounded-2xl p-3 bg-white">
      <div className="font-medium mb-2">Live Preview</</div>
      <div className="prose prose-neutral max-w-none">
        {lines.map((ln, i)=> {
          const todo = ln.match(/^\s*\[( |x|X)\]\s*(.+)$/);
          if (todo) {
            const done = /x/i.test(todo[1]);
            return (
              <div key={i} className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={done} readOnly className="mt-1" />
                <span className={done? "line-through text-neutral-400": ""}>{todo[2]}</span>
              </div>
            );
          }
          const h = ln.match(/^\s*(#{1,3})\s+(.*)$/);
          if (h) {
            const level = h[1].length; const text = h[2];
            const Tag = level===1? "h1" : level===2? "h2" : "h3";
            const className = "mt-3";
            return React.createElement(Tag, { key: i, className }, text);
          }
          return <p key={i} className="text-sm">{ln || <span className="opacity-0">.</span>}</p>;
        })}
      </div>
    </div>
  );
}

/** Suggestion View **/
function SuggestionView({ suggestion, onAddReminder }) {
  const [when, setWhen] = useState("");
  const dt = useMemo(() => {
    try { const d = parseWhen(when); return d?.toISOString?.() || ""; } catch { return ""; }
  }, [when]);

  const modelRef = useRef(loadModel());

  const accept = () => {
    const fallback = new Date(Date.now() + 5*60*1000).toISOString();
    const w = dt || fallback;
    const text = `Return package @ ${suggestion.poi?.name || "nearby location"}`;
    onAddReminder(text, w);
    try { recordNudge(modelRef.current, suggestion.poi.id, "returns", "accept"); } catch {}
    setWhen("");
    notify("Reminder scheduled", text);
  };
  const snooze = () => { try { recordNudge(modelRef.current, suggestion.poi.id, "returns", "snooze"); } catch {}; notify("Snoozed", "We’ll remind you again later."); };
  const dontShowHere = () => {
    try { recordNudge(modelRef.current, suggestion.poi.id, "returns", "dismiss"); recordNudge(modelRef.current, suggestion.poi.id, "returns", "dismiss"); } catch {}
    notify("Okay", "We won’t suggest here again.");
  };

  return (
    <div className="rounded-2xl border bg-white shadow-sm">
      <div className="p-3 border-b text-sm">
        <span className="font-medium">{suggestion.message}</span>
        {typeof suggestion.distance === "number" && (<span className="text-neutral-500"> • {suggestion.distance}m away</span>)}
      </div>
      <div className="p-3 space-y-2">
        <div className="flex gap-2 items-center">
          <input className="px-3 py-2 border rounded-xl bg-white w-full" placeholder="When? (e.g., now, today 6pm, tomorrow 9:30)" value={when} onChange={(e)=> setWhen(e.target.value)} />
          <button className="px-3 py-2 rounded-xl border bg-white hover:bg-neutral-50 inline-flex items-center" onClick={accept}><Bell className="w-4 h-4 mr-1" /> Remind me</button>
        </div>
        <div className="flex gap-2 text-xs">
          <button className="px-3 py-1 rounded-xl border hover:bg-neutral-50" onClick={snooze}>Snooze 1h</button>
          <button className="px-3 py-1 rounded-xl border hover:bg-neutral-50" onClick={dontShowHere}>Don’t show at this place</button>
        </div>
        {suggestion.poi && (<div className="text-[11px] text-neutral-600">Anchor-based nudge • Buddy: <b>{suggestion.poi.name}</b></div>)}
      </div>
    </div>
  );
}

function parseWhen(s){
  if (!s) return null;
  const iso = (()=> { try { const d = chrono.parseDate(s, new Date(), { forwardDate: true }); return d ? d.toISOString() : null; } catch { return null; } })();
  if (iso) return new Date(iso);
  const now = new Date(); const lower = s.trim().toLowerCase();
  const m = lower.match(/(today|tomorrow)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (m) {
    const day = m[1]; let h = parseInt(m[2],10); const min = m[3]? parseInt(m[3],10):0; const ampm = m[4];
    if (ampm) { if (ampm==="pm" && h<12) h+=12; if (ampm==="am" && h===12) h=0; }
    const d = new Date(now); if (day==="tomorrow") d.setDate(d.getDate()+1); d.setHours(h, min, 0, 0); return d;
  }
  const asDate = new Date(s); if (!isNaN(asDate.getTime())) return asDate; return null;
}

/** Seed **/
function seedState(){
  const nbId = uuid(); const noteId = uuid();
  return {
    notebooks: [{ id: nbId, name: "Personal" }],
    notes: [{
      id: noteId, notebookId: nbId, title: "Errands & Thoughts",
      content: `# This week

[ ] return Amazon package
[ ] buy groceries for dinner
[ ] call mom

Brain dump:
- idea: mood-based playlist agent
- schedule dentist appointment next month
`, createdAt: nowISO(), updatedAt: nowISO()
    }],
    reminders: [],
    ui: { selectedNotebookId: nbId, selectedNoteId: noteId },
  };
}
