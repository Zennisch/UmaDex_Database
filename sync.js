const fs = require("fs");
const path = require("path");

// Configuration
const GAMETORA_BASE_URL = "https://gametora.com";
const OUTPUT_DIR = __dirname;

// User Agent Configuration
const repoUrl = "https://github.com/zennisch/umadex-database";
const contactEmail = process.env.CONTACT_EMAIL || "";
const USER_AGENT = `UmaDex-SyncBot/1.0 (+${repoUrl}${contactEmail ? `; ${contactEmail}` : ""})`;

// Helper to apply XOR obfuscation
function obfuscate(buffer) {
  const xorKey = 0x5A;
  const result = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    result[i] = buffer[i] ^ xorKey;
  }
  return result;
}

// Fetch helper with User-Agent
async function fetchWithRetry(url, isBinary = false, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Fetching: ${url} (Attempt ${i + 1}/${retries})`);
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (isBinary) {
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } else {
        return await response.text();
      }
    } catch (error) {
      console.warn(`Attempt ${i + 1} failed for ${url}:`, error.message);
      if (i === retries - 1) throw error;
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

// Main Sync Function
async function main() {
  console.log("Starting UmaDex Data Mirror Sync...");
  console.log(`Using User-Agent: ${USER_AGENT}`);

  try {
    // 1. Fetch & obfuscate Manifest
    const manifestUrl = `${GAMETORA_BASE_URL}/data/manifests/umamusume.json`;
    const manifestText = await fetchWithRetry(manifestUrl, false);
    const manifest = JSON.parse(manifestText);

    // Save obfuscated manifest
    const manifestPath = path.join(OUTPUT_DIR, "manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, obfuscate(Buffer.from(manifestText)));
    console.log("✓ Manifest synchronized and obfuscated.");

    // 2. Download and obfuscate DB JSON files
    const dbFiles = [
      { field: "characters", hash: manifest.characters, filename: "characters" },
      { field: "character-cards", hash: manifest["character-cards"], filename: "character-cards" },
      { field: "db-files/succession_relation", hash: manifest["db-files/succession_relation"], filename: "succession_relation" },
      { field: "db-files/succession_relation_member", hash: manifest["db-files/succession_relation_member"], filename: "succession_relation_member" },
    ];

    for (const file of dbFiles) {
      const url = `${GAMETORA_BASE_URL}/data/umamusume/${file.field}.${file.hash}.json`;
      const text = await fetchWithRetry(url, false);
      
      // Save obfuscated JSON under data/umamusume/
      const filePath = path.join(OUTPUT_DIR, "data", "umamusume", `${file.field}.${file.hash}.json`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, obfuscate(Buffer.from(text)));
      console.log(`✓ DB File synchronized & obfuscated: ${file.field}`);
    }

    // 3. Cache character portrait thumbnail images
    console.log("Parsing character list for thumbnail image caching...");
    const charactersText = await fetchWithRetry(`${GAMETORA_BASE_URL}/data/umamusume/characters.${manifest.characters}.json`, false);
    const characters = JSON.parse(charactersText);

    const cardsText = await fetchWithRetry(`${GAMETORA_BASE_URL}/data/umamusume/character-cards.${manifest["character-cards"]}.json`, false);
    const cards = JSON.parse(cardsText);

    // Pre-build char_id -> card_id map
    const charToCard = {};
    for (const card of cards) {
      if (!charToCard[card.char_id]) {
        charToCard[card.char_id] = card.card_id;
      }
    }

    let successCount = 0;
    let skipCount = 0;

    for (const chara of characters) {
      const cardId = charToCard[chara.char_id];
      if (!cardId) continue;

      const imgName = `chara_stand_${chara.char_id}_${cardId}.png`;
      const imgPath = path.join(OUTPUT_DIR, "images", "umamusume", "characters", "thumb", imgName);

      // Check if image already exists locally to skip downloading (smart incremental cache)
      if (fs.existsSync(imgPath)) {
        skipCount++;
        continue;
      }

      const imgUrl = `${GAMETORA_BASE_URL}/images/umamusume/characters/thumb/${imgName}`;
      try {
        const imgBuffer = await fetchWithRetry(imgUrl, true);
        fs.mkdirSync(path.dirname(imgPath), { recursive: true });
        fs.writeFileSync(imgPath, obfuscate(imgBuffer));
        successCount++;
      } catch (err) {
        console.error(`✗ Failed to download image ${imgName}:`, err.message);
      }
    }

    console.log(`\nSync Completed Successfully!`);
    console.log(`- Images downloaded & obfuscated: ${successCount}`);
    console.log(`- Images skipped (already cached): ${skipCount}`);
  } catch (error) {
    console.error("Critical Sync Error:", error.message);
    process.exit(1);
  }
}

main();
