const fs = require("fs");
const path = require("path");

// Configuration
const GAMETORA_BASE_URL = "https://gametora.com";
const GAMETORA_MEDIA_BASE_URL = "https://media.gametora.com";
const OUTPUT_DIR = __dirname;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// User Agent Configuration
const repoUrl = "https://github.com/zennisch/UmaDex_Database";
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
async function fetchWithRetry(url, isBinary = false, retries = 3, validate = null) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Fetching: ${url} (Attempt ${i + 1}/${retries})`);
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      let result;
      if (isBinary) {
        const arrayBuffer = await response.arrayBuffer();
        result = Buffer.from(arrayBuffer);
      } else {
        result = await response.text();
      }

      if (validate && !validate(result)) {
        throw new Error("Response content failed validation");
      }

      return result;
    } catch (error) {
      console.warn(`Attempt ${i + 1} failed for ${url}:`, error.message);
      if (i === retries - 1) throw error;
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

function isPng(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

function isValidObfuscatedPng(filePath) {
  if (!fs.existsSync(filePath)) return false;

  try {
    return isPng(obfuscate(fs.readFileSync(filePath)));
  } catch {
    return false;
  }
}

function writeObfuscatedFileAtomic(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    fs.writeFileSync(temporaryPath, obfuscate(buffer));

    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      // Windows does not always replace an existing destination atomically.
      if (!["EEXIST", "EPERM"].includes(error.code) || !fs.existsSync(filePath)) {
        throw error;
      }
      fs.unlinkSync(filePath);
      fs.renameSync(temporaryPath, filePath);
    }
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function getUniqueSkillIconIds(skills) {
  if (!Array.isArray(skills)) {
    throw new Error("Skills database must be a JSON array");
  }

  const iconIds = new Set();

  for (const skill of skills) {
    const iconId = skill?.iconid;
    // GameTora uses 0 as a sentinel for skills that do not have an icon asset.
    if (iconId == null || iconId === 0) continue;

    if (!Number.isSafeInteger(iconId) || iconId < 0) {
      throw new Error(`Invalid skill iconid: ${JSON.stringify(iconId)}`);
    }

    iconIds.add(iconId);
  }

  return iconIds;
}

function cleanupStaleSkillIcons(iconIds) {
  const iconDirectory = path.join(OUTPUT_DIR, "images", "umamusume", "skills", "icon");
  if (!fs.existsSync(iconDirectory)) return 0;

  const expectedFileNames = new Set([...iconIds].map((iconId) => `${iconId}.png`));
  let removedCount = 0;

  for (const entry of fs.readdirSync(iconDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d+\.png$/.test(entry.name)) continue;
    if (expectedFileNames.has(entry.name)) continue;

    fs.unlinkSync(path.join(iconDirectory, entry.name));
    removedCount++;
    console.log(`- Removed stale skill icon: ${entry.name}`);
  }

  return removedCount;
}

async function syncSkillIcons(skills) {
  const iconIds = getUniqueSkillIconIds(skills);
  const stats = {
    totalSkills: skills.length,
    uniqueIcons: iconIds.size,
    downloaded: 0,
    redownloaded: 0,
    skipped: 0,
    removed: 0,
  };

  console.log(`- Skills found: ${stats.totalSkills}`);
  console.log(`- Unique skill icons found: ${stats.uniqueIcons}`);

  for (const iconId of [...iconIds].sort((a, b) => a - b)) {
    const iconName = `${iconId}.png`;
    const iconPath = path.join(
      OUTPUT_DIR,
      "images",
      "umamusume",
      "skills",
      "icon",
      iconName
    );
    const iconExists = fs.existsSync(iconPath);

    if (isValidObfuscatedPng(iconPath)) {
      stats.skipped++;
      continue;
    }

    if (iconExists) {
      console.warn(`Invalid cached skill icon will be downloaded again: ${iconName}`);
    }

    const iconUrl = `${GAMETORA_MEDIA_BASE_URL}/umamusume/skills/icon/${iconName}`;
    const iconBuffer = await fetchWithRetry(iconUrl, true, 3, isPng);
    writeObfuscatedFileAtomic(iconPath, iconBuffer);

    if (iconExists) {
      stats.redownloaded++;
    } else {
      stats.downloaded++;
    }
  }

  stats.removed = cleanupStaleSkillIcons(iconIds);
  return stats;
}

function getManifestDataFiles(manifest) {
  const files = new Set();

  for (const [field, hash] of Object.entries(manifest)) {
    if (typeof hash !== "string" || !hash) continue;
    files.add(path.normalize(`${field}.${hash}.json`));
  }

  return files;
}

function removeEmptyDirectories(directory, rootDirectory) {
  if (!fs.existsSync(directory)) return;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirectories(path.join(directory, entry.name), rootDirectory);
    }
  }

  if (directory === rootDirectory) return;
  if (fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
  }
}

function cleanupStaleDataFiles(manifest, syncedFiles) {
  const dataRoot = path.join(OUTPUT_DIR, "data", "umamusume");
  if (!fs.existsSync(dataRoot)) return;

  const expectedFiles = getManifestDataFiles(manifest);
  for (const file of syncedFiles) {
    expectedFiles.add(path.normalize(file));
  }

  let removedCount = 0;

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      const relativePath = path.normalize(path.relative(dataRoot, entryPath));
      if (!expectedFiles.has(relativePath)) {
        fs.unlinkSync(entryPath);
        removedCount++;
        console.log(`- Removed stale data file: ${path.join("data", "umamusume", relativePath)}`);
      }
    }
  }

  visit(dataRoot);
  removeEmptyDirectories(dataRoot, dataRoot);
  console.log(`- Stale data files removed: ${removedCount}`);
}

async function syncDbFile(file, syncedFiles) {
  const relativeFile = path.normalize(`${file.field}.${file.hash}.json`);
  const url = `${GAMETORA_BASE_URL}/data/umamusume/${relativeFile.replace(/\\/g, "/")}`;
  const text = await fetchWithRetry(url, false);

  const filePath = path.join(OUTPUT_DIR, "data", "umamusume", relativeFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, obfuscate(Buffer.from(text)));
  syncedFiles.add(relativeFile);
  console.log(`✓ ${relativeFile.replace(/\\/g, "/")} synchronized & obfuscated.`);

  return text;
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

    // 2. Fetch & obfuscate DB JSON files
    const syncedDataFiles = new Set();
    const dbFiles = [
      { field: "db-files/succession_relation", hash: manifest["db-files/succession_relation"] },
      { field: "db-files/succession_relation_member", hash: manifest["db-files/succession_relation_member"] },
    ];

    for (const file of dbFiles) {
      await syncDbFile(file, syncedDataFiles);
    }

    const charactersText = await syncDbFile(
      { field: "characters", hash: manifest.characters },
      syncedDataFiles
    );

    const cardsText = await syncDbFile(
      { field: "character-cards", hash: manifest["character-cards"] },
      syncedDataFiles
    );

    const skillsText = await syncDbFile(
      { field: "skills", hash: manifest.skills },
      syncedDataFiles
    );

    cleanupStaleDataFiles(manifest, syncedDataFiles);

    // 3. Cache character portrait thumbnail images
    console.log("Parsing character list for thumbnail image caching...");
    const characters = JSON.parse(charactersText);
    const cards = JSON.parse(cardsText);
    const skills = JSON.parse(skillsText);
    
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

    // 4. Cache unique skill icon images
    console.log("Parsing skills list for icon image caching...");
    const skillIconStats = await syncSkillIcons(skills);

    console.log(`\nSync Completed Successfully!`);
    console.log(`- Character images downloaded & obfuscated: ${successCount}`);
    console.log(`- Character images skipped (already cached): ${skipCount}`);
    console.log(`- Skills synchronized: ${skillIconStats.totalSkills}`);
    console.log(`- Unique skill icons: ${skillIconStats.uniqueIcons}`);
    console.log(`- Skill icons downloaded & obfuscated: ${skillIconStats.downloaded}`);
    console.log(`- Skill icons re-downloaded: ${skillIconStats.redownloaded}`);
    console.log(`- Skill icons skipped (valid cache): ${skillIconStats.skipped}`);
    console.log(`- Stale skill icons removed: ${skillIconStats.removed}`);
  } catch (error) {
    console.error("Critical Sync Error:", error.message);
    process.exit(1);
  }
}

main();
