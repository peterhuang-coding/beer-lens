#!/usr/bin/env node
/**
 * beer-crawler.mjs — Extract real beer data from beer.db.
 *
 * Sources: 14,228 RateBeer entries + 1,253 Untappd cache entries
 * Outputs 200+ beers in EnrichedBeer-compatible format.
 *
 * Usage:
 *   node scripts/beer-crawler.mjs                    # 200+ diverse beers
 *   node scripts/beer-crawler.mjs --style "IPA"      # Filter by style
 *   node scripts/beer-crawler.mjs --limit 50         # Limit count
 *   node scripts/beer-crawler.mjs --seed-only        # Only seed list
 *   node scripts/beer-crawler.mjs --output <path>    # Custom output
 *   node scripts/beer-crawler.mjs --count 300        # Target count
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();

// ── Seed Beer List ──

const SEED_BEERS = [
  { name: "Pliny the Elder", brewery: "Russian River Brewing", style: "Double IPA", abv: 8.0 },
  { name: "Heady Topper", brewery: "The Alchemist", style: "Double IPA", abv: 8.0 },
  { name: "King Sue", brewery: "Toppling Goliath Brewing", style: "Double New England IPA", abv: 7.8 },
  { name: "Zombie Dust", brewery: "3 Floyds Brewing", style: "American Pale Ale", abv: 6.5 },
  { name: "Julius", brewery: "Tree House Brewing", style: "New England IPA", abv: 6.8 },
  { name: "Pseudo Sue", brewery: "Toppling Goliath Brewing", style: "American Pale Ale", abv: 5.8 },
  { name: "90 Minute IPA", brewery: "Dogfish Head Craft Brewery", style: "Double IPA", abv: 9.0 },
  { name: "Enjoy By IPA", brewery: "Stone Brewing", style: "Double IPA", abv: 9.4 },
  { name: "Hopslam", brewery: "Bell's Brewery", style: "Double IPA", abv: 10.0 },
  { name: "Two Hearted Ale", brewery: "Bell's Brewery", style: "American IPA", abv: 7.0 },
  { name: "Blind Pig IPA", brewery: "Russian River Brewing", style: "American IPA", abv: 6.25 },
  { name: "Dinner", brewery: "Maine Beer Company", style: "Double IPA", abv: 8.2 },
  { name: "Lunch", brewery: "Maine Beer Company", style: "American IPA", abv: 7.0 },
  { name: "Sculpin IPA", brewery: "Ballast Point Brewing", style: "American IPA", abv: 7.0 },
  { name: "Focal Banger", brewery: "The Alchemist", style: "American IPA", abv: 8.0 },
  { name: "Sip of Sunshine", brewery: "Lawson's Finest Liquids", style: "New England IPA", abv: 8.0 },
  { name: "Sierra Nevada Pale Ale", brewery: "Sierra Nevada Brewing", style: "American Pale Ale", abv: 5.6 },
  { name: "Parabola", brewery: "Firestone Walker Brewing", style: "Russian Imperial Stout", abv: 13.0 },
  { name: "Bourbon County Brand Stout", brewery: "Goose Island Beer Co", style: "Imperial Stout", abv: 14.7 },
  { name: "Founders Breakfast Stout", brewery: "Founders Brewing Co", style: "Imperial Stout", abv: 8.3 },
  { name: "KBS", brewery: "Founders Brewing Co", style: "Imperial Stout", abv: 12.0 },
  { name: "Ten Fidy", brewery: "Oskar Blues Brewing", style: "Imperial Stout", abv: 10.5 },
  { name: "Prairie Bomb!", brewery: "Prairie Artisan Ales", style: "Imperial Stout", abv: 13.0 },
  { name: "Dark Lord", brewery: "3 Floyds Brewing", style: "Russian Imperial Stout", abv: 15.0 },
  { name: "Mexican Cake", brewery: "Westbrook Brewing", style: "Imperial Stout", abv: 10.5 },
  { name: "Old Rasputin", brewery: "North Coast Brewing", style: "Russian Imperial Stout", abv: 9.0 },
  { name: "Yeti Imperial Stout", brewery: "Great Divide Brewing", style: "Imperial Stout", abv: 9.5 },
  { name: "Guinness Draught", brewery: "Guinness", style: "Irish Dry Stout", abv: 4.2 },
  { name: "Dragon's Milk", brewery: "New Holland Brewing", style: "Imperial Stout", abv: 11.0 },
  { name: "Supplication", brewery: "Russian River Brewing", style: "American Wild Ale", abv: 7.5 },
  { name: "Consecration", brewery: "Russian River Brewing", style: "American Wild Ale", abv: 10.0 },
  { name: "Rodenbach Grand Cru", brewery: "Rodenbach", style: "Flanders Red Ale", abv: 6.0 },
  { name: "Duchesse de Bourgogne", brewery: "Brouwerij Verhaeghe", style: "Flanders Red Ale", abv: 6.2 },
  { name: "Cantillon Gueuze", brewery: "Brasserie Cantillon", style: "Gueuze", abv: 5.0 },
  { name: "3 Fonteinen Oude Geuze", brewery: "Brouwerij 3 Fonteinen", style: "Gueuze", abv: 6.0 },
  { name: "Lindemans Framboise", brewery: "Lindemans Brewery", style: "Lambic", abv: 2.5 },
  { name: "Pilsner Urquell", brewery: "Plzeňský Prazdroj", style: "Czech Pilsner", abv: 4.4 },
  { name: "Weihenstephaner Helles", brewery: "Bayerische Staatsbrauerei Weihenstephan", style: "Helles", abv: 5.1 },
  { name: "Ayinger Celebrator", brewery: "Ayinger Brewery", style: "Doppelbock", abv: 6.7 },
  { name: "Brooklyn Lager", brewery: "Brooklyn Brewery", style: "American Lager", abv: 5.2 },
  { name: "Yuengling Traditional Lager", brewery: "D.G. Yuengling & Son", style: "American Lager", abv: 4.5 },
  { name: "Stella Artois", brewery: "AB InBev", style: "Euro Pale Lager", abv: 5.0 },
  { name: "Heineken", brewery: "Heineken", style: "Euro Pale Lager", abv: 5.0 },
  { name: "Sam Adams Boston Lager", brewery: "Boston Beer Company", style: "American Lager", abv: 5.0 },
  { name: "Westvleteren 12", brewery: "Abbey of Saint Sixtus of Westvleteren", style: "Belgian Quadrupel", abv: 10.2 },
  { name: "Rochefort 10", brewery: "Abbey of Rochefort", style: "Belgian Quadrupel", abv: 11.3 },
  { name: "St. Bernardus Abt 12", brewery: "St. Bernardus Brewery", style: "Belgian Quadrupel", abv: 10.0 },
  { name: "Tripel Karmeliet", brewery: "Brouwerij Bosteels", style: "Belgian Tripel", abv: 8.4 },
  { name: "Chimay Blue", brewery: "Abbaye de Scourmont", style: "Belgian Dubbel", abv: 9.0 },
  { name: "Duvel", brewery: "Duvel Moortgat", style: "Belgian Strong Golden Ale", abv: 8.5 },
  { name: "Orval", brewery: "Orval Brewery", style: "Belgian Pale Ale", abv: 6.2 },
  { name: "Delirium Tremens", brewery: "Huyghe Brewery", style: "Belgian Strong Pale Ale", abv: 9.0 },
  { name: "Weihenstephaner Hefeweissbier", brewery: "Bayerische Staatsbrauerei Weihenstephan", style: "Hefeweizen", abv: 5.4 },
  { name: "Paulaner Hefe-Weissbier", brewery: "Paulaner Brauerei", style: "Hefeweizen", abv: 5.5 },
  { name: "Hoegaarden", brewery: "Hoegaarden Brewery", style: "Witbier", abv: 4.9 },
  { name: "Allagash White", brewery: "Allagash Brewing", style: "Witbier", abv: 5.0 },
  { name: "Bell's Oberon", brewery: "Bell's Brewery", style: "American Wheat", abv: 5.8 },
  { name: "Tsingtao Lager", brewery: "Tsingtao Brewery", style: "American Lager", abv: 4.7 },
  { name: "Great Leap #6 IPA", brewery: "Great Leap Brewing", style: "American IPA", abv: 6.2 },
  { name: "Master Gao Zhujiang Red", brewery: "Master Gao Brewing", style: "Irish Red Ale", abv: 5.2 },
  { name: "Sierra Nevada Bigfoot", brewery: "Sierra Nevada Brewing", style: "American Barleywine", abv: 9.6 },
  { name: "Fuller's London Pride", brewery: "Fuller's Brewery", style: "English Pale Ale", abv: 4.7 },
  { name: "Samuel Smith's Nut Brown Ale", brewery: "Samuel Smith's", style: "English Brown Ale", abv: 5.0 },
  { name: "Newcastle Brown Ale", brewery: "Newcastle Brewery", style: "English Brown Ale", abv: 4.7 },
  { name: "Coors Banquet", brewery: "Coors Brewing", style: "American Lager", abv: 5.0 },
  { name: "Modelo Especial", brewery: "Grupo Modelo", style: "American Lager", abv: 4.4 },
  { name: "Corona Extra", brewery: "Grupo Modelo", style: "American Lager", abv: 4.5 },
  { name: "Rainier", brewery: "Rainier Brewing", style: "American Lager", abv: 5.0 },
  { name: "Nitro Milk Stout", brewery: "Left Hand Brewing", style: "Milk Stout", abv: 6.0 },
  { name: "Samuel Smith's Oatmeal Stout", brewery: "Samuel Smith's", style: "Oatmeal Stout", abv: 5.0 },
  { name: "Murphy's Irish Stout", brewery: "Murphy's Brewery", style: "Irish Dry Stout", abv: 4.0 },
  { name: "Obsidian Stout", brewery: "Deschutes Brewery", style: "American Stout", abv: 6.4 },
  { name: "Speedway Stout", brewery: "Alesmith Brewing", style: "Imperial Stout", abv: 12.0 },
  { name: "Stone IPA", brewery: "Stone Brewing", style: "American IPA", abv: 6.9 },
  { name: "Torpedo Extra IPA", brewery: "Sierra Nevada Brewing", style: "American IPA", abv: 7.2 },
  { name: "Racer 5 IPA", brewery: "Bear Republic Brewing", style: "American IPA", abv: 7.0 },
  { name: "Firestone Walker DBA", brewery: "Firestone Walker Brewing", style: "English Pale Ale", abv: 5.0 },
  { name: "Gumballhead", brewery: "3 Floyds Brewing", style: "American Wheat", abv: 5.6 },
  { name: "Alpha King", brewery: "3 Floyds Brewing", style: "American Pale Ale", abv: 6.66 },
  { name: "Dale's Pale Ale", brewery: "Oskar Blues Brewing", style: "American Pale Ale", abv: 6.5 },
  { name: "Hop Stoopid", brewery: "Lagunitas Brewing", style: "Double IPA", abv: 8.0 },
  { name: "Pliny the Younger", brewery: "Russian River Brewing", style: "Triple IPA", abv: 10.25 },
  { name: "La Fin Du Monde", brewery: "Unibroue", style: "Belgian Tripel", abv: 9.0 },
  { name: "Maudite", brewery: "Unibroue", style: "Belgian Strong Dark Ale", abv: 8.0 },
  { name: "Trois Pistoles", brewery: "Unibroue", style: "Belgian Strong Dark Ale", abv: 9.0 },
  { name: "Schneider Weisse Aventinus", brewery: "Schneider Weisse", style: "Weizenbock", abv: 8.2 },
  { name: "Ayinger Brau-Weisse", brewery: "Ayinger Brewery", style: "Hefeweizen", abv: 5.1 },
  { name: "Bitburger Premium Pils", brewery: "Bitburger Brauerei", style: "German Pilsner", abv: 4.8 },
  { name: "Warsteiner Premium", brewery: "Warsteiner Brewery", style: "German Pilsner", abv: 4.8 },
  { name: "Köstritzer Schwarzbier", brewery: "Köstritzer Brauerei", style: "Schwarzbier", abv: 4.8 },
  { name: "Paulaner Münchner Hell", brewery: "Paulaner Brauerei", style: "Helles", abv: 4.9 },
  { name: "Spaten Oktoberfest", brewery: "Spaten Brewery", style: "Märzen", abv: 5.9 },
  { name: "Hofbräu München", brewery: "Staatliches Hofbräuhaus", style: "Helles", abv: 5.1 },
  { name: "Augustiner Edelstoff", brewery: "Augustiner Bräu", style: "Helles", abv: 5.6 },
  { name: "Weihenstephaner Vitus", brewery: "Bayerische Staatsbrauerei Weihenstephan", style: "Weizenbock", abv: 7.7 },
  { name: "Westvleteren 8", brewery: "Abbey of Saint Sixtus of Westvleteren", style: "Belgian Dubbel", abv: 8.0 },
  { name: "Rochefort 8", brewery: "Abbey of Rochefort", style: "Belgian Dubbel", abv: 9.2 },
  { name: "St. Bernardus Witbier", brewery: "St. Bernardus Brewery", style: "Witbier", abv: 5.5 },
  { name: "Maredsous 10", brewery: "Abbaye de Maredsous", style: "Belgian Tripel", abv: 10.0 },
  { name: "Kwak", brewery: "Brouwerij Bosteels", style: "Belgian Pale Ale", abv: 8.4 },
  { name: "Gulden Draak", brewery: "Brouwerij Van Steenberge", style: "Belgian Strong Dark Ale", abv: 10.5 },
  { name: "Piraat", brewery: "Brouwerij Van Steenberge", style: "Belgian Strong Pale Ale", abv: 10.5 },
  { name: "La Chouffe", brewery: "Brasserie d'Achouffe", style: "Belgian Strong Pale Ale", abv: 8.0 },
  { name: "Chimay Red", brewery: "Abbaye de Scourmont", style: "Belgian Dubbel", abv: 7.0 },
  { name: "Chimay Triple", brewery: "Abbaye de Scourmont", style: "Belgian Tripel", abv: 8.0 },
  { name: "Schneider Weisse Tap 7", brewery: "Schneider Weisse", style: "Hefeweizen", abv: 5.4 },
  { name: "Erdinger Weissbier", brewery: "Erdinger Brewery", style: "Hefeweizen", abv: 5.3 },
  { name: "Blue Moon Belgian White", brewery: "Blue Moon Brewing", style: "Witbier", abv: 5.4 },
  { name: "Goose Island 312 Urban Wheat", brewery: "Goose Island Beer Co", style: "American Wheat", abv: 4.2 },
  { name: "Franziskaner Hefe-Weissbier", brewery: "Franziskaner Brewery", style: "Hefeweizen", abv: 5.0 },
  { name: "Dos Equis Lager", brewery: "Heineken Mexico", style: "American Lager", abv: 4.2 },
  { name: "Firestone Walker Pivo Pils", brewery: "Firestone Walker Brewing", style: "German Pilsner", abv: 5.3 },
  { name: "Trumer Pils", brewery: "Trumer Brauerei", style: "German Pilsner", abv: 4.9 },
  { name: "Victory Prima Pils", brewery: "Victory Brewing", style: "German Pilsner", abv: 5.3 },
  { name: "Old Stock Ale", brewery: "North Coast Brewing", style: "English Barleywine", abv: 12.0 },
  { name: "Thomas Hardy's Ale", brewery: "Thomas Hardy Brewing", style: "English Barleywine", abv: 11.7 },
  { name: "Boddingtons Pub Ale", brewery: "Boddingtons", style: "English Pale Ale", abv: 4.6 },
  { name: "Cantillon Kriek", brewery: "Brasserie Cantillon", style: "Lambic", abv: 5.0 },
  { name: "3 Fonteinen Oude Kriek", brewery: "Brouwerij 3 Fonteinen", style: "Kriek Lambic", abv: 5.5 },
  { name: "Liefmans Fruitesse", brewery: "Liefmans Brewery", style: "Fruit Beer", abv: 3.8 },
  { name: "La Folie", brewery: "New Belgium Brewing", style: "Flanders Sour Ale", abv: 7.0 },
  { name: "Petrus Aged Pale", brewery: "Bavik Brewery", style: "Sour Ale", abv: 5.5 },
  { name: "Westbrook Gose", brewery: "Westbrook Brewing", style: "Gose", abv: 4.0 },
  { name: "Liefmans Oud Bruin", brewery: "Liefmans Brewery", style: "Oud Bruin", abv: 5.0 },
  { name: "Berliner Weisse", brewery: "Bayerischer Bahnhof", style: "Berliner Weisse", abv: 5.0 },
  { name: "Rodenbach Caractère Rouge", brewery: "Rodenbach", style: "Flanders Red Ale", abv: 7.0 },
  { name: "Cantillon Fou Foune", brewery: "Brasserie Cantillon", style: "Lambic", abv: 5.5 },
  { name: "Cantillon Lou Pepe", brewery: "Brasserie Cantillon", style: "Gueuze", abv: 5.0 },
  { name: "Elijah Craig Barrel Aged Stout", brewery: "Central Waters Brewing", style: "Imperial Stout", abv: 11.0 },
  { name: "Barrel-Aged Abraxas", brewery: "Perennial Artisan Ales", style: "Imperial Stout", abv: 12.5 },
  { name: "Dogfish Head Worldwide Stout", brewery: "Dogfish Head Craft Brewery", style: "Imperial Stout", abv: 18.0 },
  { name: "Imperial Biscotti Break", brewery: "Evil Twin Brewing", style: "Imperial Stout", abv: 11.5 },
  { name: "Prairie Noir", brewery: "Prairie Artisan Ales", style: "Imperial Stout", abv: 12.0 },
  { name: "Wake Up Dead", brewery: "Left Hand Brewing", style: "Russian Imperial Stout", abv: 9.4 },
  { name: "Temptation", brewery: "Russian River Brewing", style: "American Wild Ale", abv: 7.5 },
  { name: "Beatification", brewery: "Russian River Brewing", style: "American Wild Ale", abv: 6.5 },
  { name: "Citra Daydream", brewery: "Modern Times Beer", style: "New England IPA", abv: 7.0 },
  { name: "Space Cake", brewery: "Modern Times Beer", style: "Double IPA", abv: 8.5 },
  { name: "Hop Drop 'N Roll", brewery: "NoDa Brewing", style: "American IPA", abv: 7.2 },
  { name: "Nelson", brewery: "Hill Farmstead Brewery", style: "Double IPA", abv: 8.0 },
  { name: "Double Sunshine", brewery: "Lawson's Finest Liquids", style: "Double IPA", abv: 8.9 },
  { name: "Crusher", brewery: "Tree House Brewing", style: "Double IPA", abv: 7.8 },
  { name: "Green", brewery: "Tree House Brewing", style: "American IPA", abv: 6.3 },
  { name: "DDH Pseudo Sue", brewery: "Toppling Goliath Brewing", style: "Double New England IPA", abv: 8.6 },
  { name: "Snow Beer", brewery: "CR Snow", style: "American Lager", abv: 3.4 },
  { name: "Harbin Beer", brewery: "Harbin Brewery", style: "American Lager", abv: 4.0 },
  { name: "Boxing Cat Iron Throne", brewery: "Boxing Cat Brewery", style: "American IPA", abv: 6.5 },
  { name: "Great Leap Honey Ma Gold", brewery: "Great Leap Brewing", style: "Blonde Ale", abv: 5.0 },
];

// ── Helpers ──

function runPython(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", args, {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error(`JSON parse error: ${stdout.slice(0, 200)}`)); }
      } else {
        reject(new Error(`python3 exit ${code}: ${stderr.slice(0, 300)}`));
      }
    });
    proc.on("error", reject);
  });
}

// ── Lookup a beer in beer.db ──

async function lookupBeer(beerName) {
  try {
    const result = await runPython([".beer-data/lookup.py", beerName]);
    if (result && result.results && result.results.length > 0) {
      return result.results[0];
    }
  } catch { /* ignore */ }
  return null;
}

// ── Parse args ──

function parseArgs(argv) {
  const args = {
    style: null,
    limit: 0,
    seedOnly: false,
    output: "data/raw-crawl/beer-crawl-results.json",
    count: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--style" || a === "-s") args.style = argv[++i];
    else if (a === "--limit" || a === "-l") args.limit = parseInt(argv[++i]) || 0;
    else if (a === "--seed-only") args.seedOnly = true;
    else if (a === "--count" || a === "-c") args.count = parseInt(argv[++i]) || 200;
    else if (a === "--output" || a === "-o") args.output = argv[++i];
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`Beer Crawler — extract beer data from beer.db (14k RateBeer + 1.2k Untappd)

Usage:
  node scripts/beer-crawler.mjs                    # 200+ diverse beers
  node scripts/beer-crawler.mjs --style "IPA"      # Filter by style
  node scripts/beer-crawler.mjs --limit 50         # Limit count
  node scripts/beer-crawler.mjs --seed-only        # Only use seed list
  node scripts/beer-crawler.mjs --count 300        # Target count
  node scripts/beer-crawler.mjs --output <path>    # Custom output
`);
}

// ── Main ──

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const now = new Date().toISOString();

  // Phase 1: Lookup seed beers in beer.db
  let seedBeers = [...SEED_BEERS];
  if (args.style) {
    const filter = args.style.toLowerCase();
    seedBeers = seedBeers.filter(b =>
      b.style.toLowerCase().includes(filter) ||
      b.name.toLowerCase().includes(filter)
    );
    console.log(`\nFiltered to ${seedBeers.length} seed beers matching "${args.style}"`);
  }

  if (args.limit > 0) {
    seedBeers = seedBeers.slice(0, args.limit);
  }

  console.log(`\nLooking up ${seedBeers.length} seed beers in beer.db...`);
  const seedResults = [];

  for (let i = 0; i < seedBeers.length; i++) {
    const beer = seedBeers[i];
    const dbResult = await lookupBeer(beer.name);

    if (dbResult && dbResult.found) {
      seedResults.push({
        beerName: beer.name,
        breweryName: dbResult.brewery || beer.brewery,
        style: dbResult.style || beer.style || "",
        abv: dbResult.abv || beer.abv || 0,
        ibu: null,
        hops: [],
        untappdId: dbResult.source === "untappd" ? dbResult.id : null,
        untappdScore: dbResult.rating || null,
        untappdRatingCount: dbResult.ratings_count || null,
        untappdUrl: dbResult.untappd_url || null,
        breweryCountry: dbResult.country || null,
        labelImage: dbResult.label_image || null,
        source: dbResult.source === "untappd" ? "untappd" : "ratebeer",
        verified: false,
        confidence: 0.75,
        crawledAt: now,
      });
    } else {
      seedResults.push({
        beerName: beer.name,
        breweryName: beer.brewery,
        style: beer.style || "",
        abv: beer.abv || 0,
        ibu: null,
        hops: [],
        untappdId: null,
        untappdScore: null,
        untappdRatingCount: null,
        untappdUrl: null,
        breweryCountry: null,
        labelImage: null,
        source: "seed",
        verified: false,
        confidence: 0.5,
        crawledAt: now,
      });
    }

    if ((i + 1) % 20 === 0 || i === seedBeers.length - 1) {
      process.stdout.write(`  [${i + 1}/${seedBeers.length}] lookup progress: ${seedResults.filter(r => r.source !== "seed").length} found in DB\n`);
    }
  }

  // Phase 2: Extract diverse beers using the Python script
  let dbExtracted = [];
  if (!args.seedOnly) {
    const targetCount = Math.max(args.count, seedBeers.length + 50);
    console.log(`\nExtracting ${targetCount} diverse beers from beer.db (via Python)...`);
    
    try {
      dbExtracted = await runPython(["scripts/extract-diverse-beers.py", String(targetCount)]);
      console.log(`  Got ${dbExtracted.length} beers from Python extraction`);
    } catch (err) {
      console.log(`  Python extraction failed: ${err.message}`);
    }
  }

  // Combine and deduplicate
  const allResults = [...seedResults, ...dbExtracted];
  const seenFinal = new Set();
  const uniqueResults = allResults.filter(r => {
    const key = (r.beerName || "").toLowerCase().trim();
    if (!key) return false;
    if (seenFinal.has(key)) return false;
    seenFinal.add(key);
    return true;
  });

  // Fill crawledAt
  for (const r of uniqueResults) {
    if (!r.crawledAt) r.crawledAt = now;
  }

  // Write output
  const outputPath = path.resolve(ROOT, args.output);
  const outputDir = path.dirname(outputPath);
  await mkdir(outputDir, { recursive: true });

  const output = {
    crawledAt: now,
    totalBeers: uniqueResults.length,
    seedBeersIncluded: seedResults.length,
    dbExtractedCount: dbExtracted.length,
    beerSamples: uniqueResults.slice(0, 5).map(r => ({
      name: r.beerName,
      brewery: r.breweryName,
      score: r.untappdScore,
      style: r.style,
      source: r.source,
    })),
    beers: uniqueResults,
  };

  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");

  // Stats
  const withScore = uniqueResults.filter(b => b.untappdScore != null).length;
  const withAbv = uniqueResults.filter(b => b.abv > 0).length;
  const withStyle = uniqueResults.filter(b => b.style && b.style.length > 0).length;
  const withBrewery = uniqueResults.filter(b => b.breweryName && b.breweryName.length > 0).length;
  const untappdSource = uniqueResults.filter(b => b.source === "untappd").length;
  const ratebeerSource = uniqueResults.filter(b => b.source === "ratebeer").length;
  const seedOnlySource = uniqueResults.filter(b => b.source === "seed").length;

  // Style diversity
  const styles = new Set(uniqueResults.map(b => b.style).filter(Boolean));

  console.log(`\n=== Crawl Complete ===
  Total unique beers:  ${uniqueResults.length}
  Untappd sourced:     ${untappdSource}
  RateBeer sourced:    ${ratebeerSource}
  Seed-only (nodata):  ${seedOnlySource}
  -------------------------
  With Untappd score:  ${withScore}
  With ABV:            ${withAbv}
  With Style:          ${withStyle}
  With Brewery:        ${withBrewery}
  Unique styles:       ${styles.size}
  Output:              ${path.relative(ROOT, outputPath)}
`);
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
