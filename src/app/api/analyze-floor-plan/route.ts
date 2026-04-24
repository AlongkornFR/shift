import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// Pro = better vision reasoning, fewer missed tables. Flash as fallback if Pro
// hits a quota/404 (some free-tier keys don't get Pro).
const GEMINI_URL_PRIMARY =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";
const GEMINI_URL_FALLBACK =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

type DetectedSpace = {
  name: string;
  zone: "restaurant" | "terrasse" | "terrasse_couverte" | "bar";
  x: number; // 0-1
  y: number; // 0-1
  width: number; // 0-1
  height: number; // 0-1
};

type DetectedTable = {
  label: string;
  x: number; // 0-1
  y: number; // 0-1
  seats: number;
  shape: "round" | "square" | "rect";
};

type GeminiResult = {
  spaces: DetectedSpace[];
  tables: DetectedTable[];
};

const PROMPT = `You analyze a restaurant floor plan image (blueprint, architectural drawing, sketch, or photo) and extract all tables and areas as structured JSON.

## Coordinate system
Normalized [0..1] where (0,0) = top-left of the IMAGE (not the drawing margin), (1,1) = bottom-right.
- Space: x,y = top-left corner of the rectangle; width,height = extent.
- Table: x,y = geometric CENTER of the table shape.

Measure coordinates by mentally overlaying a fine grid (40 columns × 28 rows) and reading the cell each element occupies. Be precise — a table at visual center-left of the image should have x≈0.25, not 0.5.

## Step-by-step procedure (apply internally, do not output these steps)
1. Scan the whole image methodically: top-left → top-right → middle rows → bottom. Do not stop at the first few tables.
2. Count all distinct table shapes. Expect 8–40 tables typical in a restaurant plan. If you see only 2–3, look harder — small round tables in corners are easy to miss.
3. For each table, record its center coordinates, its shape, and count the chairs drawn around it. If no chairs visible, estimate seats from the table size (round small = 2, round medium = 4, long rectangle = 6–8).
4. Identify enclosing rooms/zones. Classify each: "restaurant" (indoor dining room), "terrasse" (outdoor/open-air), "terrasse_couverte" (covered outdoor/veranda), "bar" (bar counter zone).
5. Re-check: every table must lie inside exactly one space. If a table is outside all spaces, either extend the nearest space or drop the table.

## What IS a table
- Round, square, rectangular shapes with chairs around them
- Numbered shapes in the dining areas
- Shapes visually isolated from walls/counters

## What IS NOT a table (exclude)
- Chairs, stools (smaller isolated circles/squares without a table next to them)
- Bar counter itself (that's a "bar" SPACE, not a table)
- Kitchen equipment, toilets, plants, columns, doors
- Walls, partitions, stairs
- Text labels, arrows, legends

## Labels
- If the plan shows visible table numbers (e.g. "12", "T4", "B2"), use exactly that text.
- Otherwise assign sequential "T1","T2","T3"... top-to-bottom, left-to-right.

## Seats rule of thumb
- Round ⌀ ≤ small: 2 seats
- Round ⌀ medium: 4 seats
- Round ⌀ large: 6–8 seats
- Square small: 2, square medium: 4
- Rectangle short: 4, rectangle long: 6–8
- Trust visible chair marks over size estimate when present.

## Limits
- Max 40 tables, max 6 spaces.
- Space names: short French ("Terrasse", "Salle principale", "Bar", "Véranda").

Return ONLY the JSON matching the schema. No commentary.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    spaces: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          zone: {
            type: "string",
            enum: ["restaurant", "terrasse", "terrasse_couverte", "bar"],
          },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["name", "zone", "x", "y", "width", "height"],
      },
    },
    tables: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          seats: { type: "number" },
          shape: { type: "string", enum: ["round", "square", "rect"] },
        },
        required: ["label", "x", "y", "seats", "shape"],
      },
    },
  },
  required: ["spaces", "tables"],
};

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", auth.user.id)
      .single();
    if (profile?.role !== "patron") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY not configured" },
        { status: 500 },
      );
    }
    console.log("[analyze-floor-plan] using key prefix:", apiKey.slice(0, 8), "len:", apiKey.length);

    const body = (await request.json()) as { imageUrl?: string };
    if (!body.imageUrl) {
      return NextResponse.json({ error: "imageUrl required" }, { status: 400 });
    }

    // Fetch image from Supabase Storage (public bucket)
    const imgRes = await fetch(body.imageUrl);
    if (!imgRes.ok) {
      return NextResponse.json(
        { error: `Image fetch failed: ${imgRes.status}` },
        { status: 502 },
      );
    }
    const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    const payload = {
      contents: [
        {
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
        // Let the model "think" before emitting JSON — big accuracy win on
        // vision counting tasks. -1 = dynamic budget (model decides).
        thinkingConfig: { thinkingBudget: -1 },
      },
    };

    async function callGemini(url: string) {
      return fetch(`${url}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    let geminiRes = await callGemini(GEMINI_URL_PRIMARY);
    // Fall back to Flash if Pro is gated (quota/permission) for this key
    if (geminiRes.status === 404 || geminiRes.status === 429 || geminiRes.status === 403) {
      console.warn("[analyze-floor-plan] Pro unavailable, falling back to Flash", geminiRes.status);
      geminiRes = await callGemini(GEMINI_URL_FALLBACK);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("[analyze-floor-plan] Gemini error", geminiRes.status, errText);
      return NextResponse.json(
        { error: `Gemini ${geminiRes.status}`, detail: errText },
        { status: 502 },
      );
    }

    const geminiJson = await geminiRes.json();
    const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return NextResponse.json(
        { error: "Empty Gemini response", raw: geminiJson },
        { status: 502 },
      );
    }

    let parsed: GeminiResult;
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON from Gemini", raw: text },
        { status: 502 },
      );
    }

    // Clamp coords into [0,1]
    const clamp = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));
    const spaces = (parsed.spaces || []).slice(0, 6).map((s) => ({
      name: String(s.name || "Espace").slice(0, 40),
      zone: s.zone,
      x: clamp(s.x),
      y: clamp(s.y),
      width: clamp(s.width),
      height: clamp(s.height),
    }));
    const tables = (parsed.tables || []).slice(0, 40).map((t, i) => ({
      label: String(t.label || `T${i + 1}`).slice(0, 8),
      x: clamp(t.x),
      y: clamp(t.y),
      seats: Math.max(1, Math.min(20, Math.round(Number(t.seats) || 4))),
      shape: t.shape || "round",
    }));

    return NextResponse.json({ spaces, tables });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
