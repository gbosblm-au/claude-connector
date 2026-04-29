import * as cheerio from "cheerio";

import { config } from "../config.js";
import { CONNECTOR_USER_AGENT } from "../config.js";
import { clamp, truncate } from "../utils/helpers.js";
import { log } from "../utils/logger.js";

const DISCOVERY_QUERY_BUILDERS = [
  (query) => query,
  (query) => `${query} official website contact email phone`,
  (query) => `${query} owner founder director manager team leadership`,
  (query) => `${query} chamber of commerce directory yellow pages yelp contact phone`,
];

const COMMON_CONTACT_PATHS = [
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
  "/team",
  "/our-team",
  "/leadership",
  "/staff",
  "/company",
  "/people",
  "/locations",
  "/sales",
];

const CONTACT_LINK_HINTS = [
  "contact",
  "about",
  "team",
  "leadership",
  "staff",
  "people",
  "company",
  "management",
  "locations",
  "sales",
  "book",
  "quote",
  "support",
  "office",
  "directory",
];

const ROLE_KEYWORDS = [
  "owner",
  "founder",
  "co-founder",
  "ceo",
  "chief executive officer",
  "managing director",
  "director",
  "principal",
  "partner",
  "president",
  "vice president",
  "vp",
  "head of",
  "manager",
  "business development",
  "sales",
  "marketing",
  "operations",
  "general manager",
  "commercial manager",
  "account manager",
  "advisor",
  "consultant",
];

const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "business",
  "businesses",
  "companies",
  "company",
  "contact",
  "contacts",
  "details",
  "email",
  "emails",
  "find",
  "for",
  "from",
  "in",
  "lead",
  "leads",
  "list",
  "me",
  "my",
  "near",
  "of",
  "on",
  "or",
  "phone",
  "phones",
  "potential",
  "prospect",
  "prospects",
  "that",
  "the",
  "their",
  "with",
]);

const BLOCKED_OFFICIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "yelp.com",
  "yellowpages.com",
  "yellowpages.ca",
  "angi.com",
  "bbb.org",
  "mapquest.com",
  "tripadvisor.com",
  "crunchbase.com",
  "manta.com",
  "clutch.co",
  "zoominfo.com",
  "apollo.io",
  "rocketreach.co",
  "signalhire.com",
  "cylex",
  "hotfrog",
  "alignable",
  "merchantcircle.com",
  "opencorporates.com",
];

const DIRECTORY_HOST_HINTS = [
  "yelp",
  "yellowpages",
  "bbb",
  "mapquest",
  "tripadvisor",
  "crunchbase",
  "manta",
  "clutch",
  "hotfrog",
  "cylex",
  "merchantcircle",
  "opencorporates",
  "superpages",
  "angi",
  "thumbtack",
  "hubspot",
  "zoominfo",
  "apollo",
  "rocketreach",
  "signalhire",
  "chamberofcommerce",
  "mapcarta",
];

const SOCIAL_HOST_HINTS = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "tiktok.com",
];

const EMAIL_REGEX = /(?:mailto:)?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,})/gi;
const PHONE_REGEX = /(?:\+?\d[\d().\-\s]{6,}\d)(?:\s?(?:x|ext\.?|extension)\s?\d{1,6})?/gi;
const NAME_REGEX = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g;
const TITLE_SPLIT_REGEX = /\s+[|\-–]\s+/g;
const MAX_FETCHED_CANDIDATES = 8;
const MAX_LEADS_RETURNED = 8;
const FETCH_TIMEOUT_MS = 8000;

export function shouldRunLeadResearch(query, args = {}) {
  const mode = String(args?.lead_mode || "auto").toLowerCase();
  if (mode === "force") return true;
  if (mode === "off") return false;
  if (args?.include_contact_details === true) return true;

  const text = String(query || "").toLowerCase();
  let score = 0;

  if (/(lead|leads|prospect|prospects|decision maker|decision-maker|outreach|target accounts?)/i.test(text)) {
    score += 3;
  }
  if (/(email|emails|phone|phones|telephone|contact number|contact details?|direct line|call|reach out)/i.test(text)) {
    score += 3;
  }
  if (/(find|identify|list|generate|source|research|build|discover|compile)/i.test(text)) {
    score += 1;
  }
  if (/(business|businesses|company|companies|agency|agencies|firm|firms|supplier|suppliers|vendor|vendors|contractor|contractors|clinic|clinics|restaurant|restaurants|law firm|accountant|accountants)/i.test(text)) {
    score += 1;
  }
  if (/(owner|founder|director|manager|ceo|principal|partner|head of sales|sales manager|marketing manager)/i.test(text)) {
    score += 1;
  }

  return score >= 4;
}

export async function runLeadResearch({
  query,
  numResults,
  freshness,
  country,
  primarySearch,
  searchDetailed,
}) {
  const discoveryQueries = DISCOVERY_QUERY_BUILDERS.map((builder) => builder(query))
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);

  const searchPromises = discoveryQueries.map((discoveryQuery, index) => {
    if (index === 0 && primarySearch) {
      return Promise.resolve(primarySearch);
    }

    return searchDetailed({
      query: discoveryQuery,
      numResults: clamp(Math.max(6, Math.min(numResults, 10)), 3, 10),
      freshness,
      country,
    });
  });

  const searchResponses = await Promise.allSettled(searchPromises);
  const successfulResponses = searchResponses
    .filter((item) => item.status === "fulfilled")
    .map((item) => item.value);

  if (successfulResponses.length === 0) {
    throw new Error("Lead research could not obtain any search responses.");
  }

  const queryTokens = tokenizeForMatching(query);
  const candidateMap = new Map();
  const detachedContacts = [];
  const pendingPageFetches = [];
  const allLocationIds = new Set();

  for (const response of successfulResponses) {
    const webResults = response?.results || [];

    for (const result of webResults) {
      const snippetEmails = extractEmails(`${result.title || ""}\n${result.description || ""}`);
      const snippetPhones = extractPhones(`${result.title || ""}\n${result.description || ""}`);
      const companyHint = cleanBusinessName(result.title || result.url || "");
      const sourceType = classifyResultSource(result.url || "");
      const officialUrl = isPotentialOfficialWebsite(result.url || "") ? stripHash(result.url) : "";
      const candidateKey = officialUrl
        ? `domain:${getHostname(officialUrl)}`
        : companyHint
          ? `name:${normalizeComparableText(companyHint)}`
          : `url:${result.url}`;

      const candidate = getOrCreateCandidate(candidateMap, candidateKey, {
        name: companyHint,
        officialWebsite: officialUrl,
      });

      mergeCandidateSignal(candidate, {
        title: result.title || "",
        sourceUrl: result.url || "",
        sourceType,
        description: result.description || "",
        name: companyHint,
        officialWebsite: officialUrl,
        emails: snippetEmails,
        phones: snippetPhones,
        relevanceBoost: scoreTextAgainstTokens(`${result.title || ""} ${result.description || ""}`, queryTokens),
      });

      const people = extractPeopleFromSearchResult(result);
      if (people.length > 0) {
        for (const person of people) {
          const matchedCandidate = findCandidateForPerson(candidateMap, person, candidate, queryTokens);
          if (matchedCandidate) {
            addContact(matchedCandidate.contacts, person);
          } else {
            detachedContacts.push(person);
          }
        }
      }

      if (officialUrl) {
        pendingPageFetches.push({
          candidateKey,
          url: officialUrl,
          reason: "official-search-result",
        });
      }
    }

    const locationResults = response?.locations || [];
    for (const location of locationResults) {
      if (location?.id) allLocationIds.add(location.id);
    }
  }

  if (config.searchProvider === "brave" && allLocationIds.size > 0) {
    try {
      const poiItems = await fetchBravePoiDetails(Array.from(allLocationIds).slice(0, 20));
      for (const poi of poiItems) {
        const parsedPoi = parsePoiLikeObject(poi);
        if (!parsedPoi.name && !parsedPoi.website && parsedPoi.phones.length === 0) {
          continue;
        }

        const key = parsedPoi.website
          ? `domain:${getHostname(parsedPoi.website)}`
          : parsedPoi.name
            ? `name:${normalizeComparableText(parsedPoi.name)}`
            : `poi:${Math.random().toString(36).slice(2)}`;

        const candidate = getOrCreateCandidate(candidateMap, key, {
          name: parsedPoi.name,
          officialWebsite: isPotentialOfficialWebsite(parsedPoi.website) ? parsedPoi.website : "",
        });

        mergeCandidateSignal(candidate, {
          title: parsedPoi.name || "",
          sourceUrl: parsedPoi.website || "",
          sourceType: "brave_local_poi",
          description: parsedPoi.address || parsedPoi.category || "",
          name: parsedPoi.name,
          officialWebsite: isPotentialOfficialWebsite(parsedPoi.website) ? parsedPoi.website : "",
          emails: parsedPoi.emails,
          phones: parsedPoi.phones,
          address: parsedPoi.address,
          relevanceBoost: 4,
        });
      }
    } catch (error) {
      log("warn", `Lead research local POI enrichment failed: ${error.message}`);
    }
  }

  for (const contact of detachedContacts) {
    const matchedCandidate = findBestCompanyMatch(candidateMap, contact.company || contact.sourceCompany || "", queryTokens);
    if (matchedCandidate) {
      addContact(matchedCandidate.contacts, contact);
    }
  }

  const selectedCandidates = Array.from(candidateMap.values())
    .map((candidate) => finalizeCandidateForSelection(candidate, queryTokens))
    .filter((candidate) => candidate.selectionScore > 0)
    .sort((left, right) => right.selectionScore - left.selectionScore)
    .slice(0, MAX_FETCHED_CANDIDATES);

  const visitedPageUrls = new Set();
  const candidatePageQueues = new Map();

  for (const candidate of selectedCandidates) {
    const urls = new Set();
    if (candidate.officialWebsite) urls.add(stripHash(candidate.officialWebsite));
    const queueEntries = pendingPageFetches.filter((entry) => entry.candidateKey === candidate.key);
    for (const entry of queueEntries) {
      if (isSameRegistrableDomain(candidate.officialWebsite, entry.url)) {
        urls.add(stripHash(entry.url));
      }
    }
    candidatePageQueues.set(candidate.key, Array.from(urls).slice(0, 4));
  }

  for (const candidate of selectedCandidates) {
    const queue = candidatePageQueues.get(candidate.key) || [];
    const firstUrl = queue[0] || candidate.officialWebsite;
    if (!firstUrl) continue;

    const initialPage = await fetchAndExtractPage(firstUrl);
    if (initialPage) {
      visitedPageUrls.add(stripHash(initialPage.pageUrl));
      mergePageSignalsIntoCandidate(candidate, initialPage);

      const sameSiteLinks = initialPage.relevantLinks
        .filter((url) => isSameRegistrableDomain(candidate.officialWebsite || firstUrl, url))
        .filter((url) => !visitedPageUrls.has(stripHash(url)));

      for (const link of sameSiteLinks.slice(0, 6)) {
        queue.push(link);
      }

      for (const guessedPath of COMMON_CONTACT_PATHS) {
        try {
          const guessedUrl = new URL(guessedPath, candidate.officialWebsite || firstUrl).toString();
          if (!visitedPageUrls.has(stripHash(guessedUrl))) queue.push(guessedUrl);
        } catch {
          // Ignore malformed base URL.
        }
      }

      if (candidate.emails.size === 0 || candidate.phones.size === 0 || candidate.contacts.length === 0) {
        const sitemapLinks = await discoverRelevantSitemapUrls(candidate.officialWebsite || firstUrl);
        for (const sitemapLink of sitemapLinks) {
          if (!visitedPageUrls.has(stripHash(sitemapLink))) {
            queue.push(sitemapLink);
          }
        }
      }
    }

    const dedupedQueue = Array.from(new Set(queue)).slice(1, 8);
    const pageResults = await Promise.allSettled(
      dedupedQueue
        .filter((url) => !visitedPageUrls.has(stripHash(url)))
        .slice(0, 7)
        .map((url) => fetchAndExtractPage(url))
    );

    for (const pageResult of pageResults) {
      if (pageResult.status !== "fulfilled" || !pageResult.value) continue;
      visitedPageUrls.add(stripHash(pageResult.value.pageUrl));
      mergePageSignalsIntoCandidate(candidate, pageResult.value);
    }
  }

  const candidatesNeedingSearch = selectedCandidates
    .filter((candidate) => !!candidate.officialWebsite)
    .filter((candidate) => candidate.emails.size === 0 || candidate.phones.size === 0 || candidate.contacts.length === 0)
    .slice(0, 3);

  const domainSearchResponses = await Promise.allSettled(
    candidatesNeedingSearch.map((candidate) =>
      searchDetailed({
        query: buildDomainSpecificQuery(candidate.officialWebsite),
        numResults: 6,
        freshness,
        country,
      })
    )
  );

  for (let index = 0; index < candidatesNeedingSearch.length; index += 1) {
    const candidate = candidatesNeedingSearch[index];
    const response = domainSearchResponses[index];
    if (!candidate || response?.status !== "fulfilled") continue;

    const sameDomainUrls = [];
    for (const result of response.value?.results || []) {
      if (!result?.url || !isSameRegistrableDomain(candidate.officialWebsite, result.url)) continue;
      mergeCandidateSignal(candidate, {
        title: result.title || "",
        sourceUrl: result.url,
        sourceType: classifyResultSource(result.url),
        description: result.description || "",
        emails: extractEmails(`${result.title || ""}\n${result.description || ""}`),
        phones: extractPhones(`${result.title || ""}\n${result.description || ""}`),
        relevanceBoost: 2,
      });
      sameDomainUrls.push(stripHash(result.url));

      for (const person of extractPeopleFromSearchResult(result)) {
        addContact(candidate.contacts, person);
      }
    }

    const supplementalPages = await Promise.allSettled(
      Array.from(new Set(sameDomainUrls))
        .filter((url) => !visitedPageUrls.has(url))
        .slice(0, 4)
        .map((url) => fetchAndExtractPage(url))
    );

    for (const supplementalPage of supplementalPages) {
      if (supplementalPage.status !== "fulfilled" || !supplementalPage.value) continue;
      visitedPageUrls.add(stripHash(supplementalPage.value.pageUrl));
      mergePageSignalsIntoCandidate(candidate, supplementalPage.value);
    }
  }

  const finalizedLeads = selectedCandidates
    .map((candidate) => finalizeLead(candidate, queryTokens))
    .filter((candidate) => candidate.emails.length > 0 || candidate.phones.length > 0 || candidate.contacts.length > 0)
    .sort((left, right) => right.finalScore - left.finalScore)
    .slice(0, MAX_LEADS_RETURNED);

  const stats = {
    total: finalizedLeads.length,
    withEmail: finalizedLeads.filter((lead) => lead.emails.length > 0).length,
    withPhone: finalizedLeads.filter((lead) => lead.phones.length > 0).length,
    withNamedContacts: finalizedLeads.filter((lead) => lead.contacts.length > 0).length,
  };

  const formattedText = formatLeadSection(query, finalizedLeads, stats);

  return {
    leads: finalizedLeads,
    stats,
    formattedText,
  };
}

function tokenizeForMatching(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !QUERY_STOP_WORDS.has(token));
}

function scoreTextAgainstTokens(text, tokens) {
  const haystack = normalizeComparableText(text || "");
  if (!haystack || tokens.length === 0) return 0;
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function normalizeComparableText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanBusinessName(value) {
  const text = normalizeWhitespace(value);
  if (!text) return "";
  const pieces = text
    .split(TITLE_SPLIT_REGEX)
    .map((piece) => piece.trim())
    .filter(Boolean);

  if (pieces.length === 0) return text;
  const preferred = pieces.find((piece) => !/linkedin|facebook|instagram|twitter|x\.com|official site/i.test(piece));
  return truncate(preferred || pieces[0], 120);
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function getRegistrableDomain(url) {
  const hostname = getHostname(url);
  if (!hostname) return "";
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

function stripHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(url || "").split("#")[0];
  }
}

function isPotentialOfficialWebsite(url) {
  const hostname = getHostname(url);
  if (!hostname) return false;
  return !BLOCKED_OFFICIAL_HOSTS.some((blockedHost) => hostname === blockedHost || hostname.endsWith(`.${blockedHost}`));
}

function isSameRegistrableDomain(leftUrl, rightUrl) {
  const left = getRegistrableDomain(leftUrl || "");
  const right = getRegistrableDomain(rightUrl || "");
  return !!left && !!right && left === right;
}

function classifyResultSource(url) {
  const hostname = getHostname(url);
  if (!hostname) return "unknown";
  if (SOCIAL_HOST_HINTS.some((hint) => hostname === hint || hostname.endsWith(`.${hint}`))) return "social";
  if (DIRECTORY_HOST_HINTS.some((hint) => hostname.includes(hint))) return "directory";
  return "website";
}

function getOrCreateCandidate(candidateMap, key, seed = {}) {
  if (!candidateMap.has(key)) {
    candidateMap.set(key, {
      key,
      name: seed.name || "",
      officialWebsite: seed.officialWebsite || "",
      sourceUrls: new Set(),
      sourceTypes: new Set(),
      emails: new Set(),
      phones: new Set(),
      contacts: [],
      address: "",
      notes: [],
      descriptions: [],
      pageUrls: new Set(),
      relevanceScore: 0,
      sourceScore: 0,
    });
  }

  return candidateMap.get(key);
}

function mergeCandidateSignal(candidate, signal) {
  if (!candidate.name && signal.name) candidate.name = signal.name;
  if (!candidate.officialWebsite && signal.officialWebsite) candidate.officialWebsite = signal.officialWebsite;
  if (!candidate.address && signal.address) candidate.address = signal.address;
  if (signal.description) candidate.descriptions.push(truncate(signal.description, 280));
  if (signal.sourceUrl) candidate.sourceUrls.add(signal.sourceUrl);
  if (signal.sourceType) candidate.sourceTypes.add(signal.sourceType);
  if (Array.isArray(signal.emails)) {
    for (const email of signal.emails) candidate.emails.add(email);
  }
  if (Array.isArray(signal.phones)) {
    for (const phone of signal.phones) candidate.phones.add(phone);
  }

  if (signal.sourceType === "website") candidate.sourceScore += 3;
  if (signal.sourceType === "brave_local_poi") candidate.sourceScore += 5;
  if (signal.sourceType === "directory") candidate.sourceScore += 1;
  if (signal.sourceType === "social") candidate.sourceScore += 1;
  candidate.relevanceScore += signal.relevanceBoost || 0;
}

function finalizeCandidateForSelection(candidate, queryTokens) {
  const keywordScore = scoreTextAgainstTokens(
    `${candidate.name} ${candidate.descriptions.join(" ")} ${Array.from(candidate.sourceUrls).join(" ")}`,
    queryTokens
  );
  const selectionScore =
    candidate.sourceScore +
    candidate.relevanceScore +
    keywordScore +
    (candidate.officialWebsite ? 6 : 0) +
    (candidate.emails.size > 0 ? 3 : 0) +
    (candidate.phones.size > 0 ? 3 : 0) +
    (candidate.contacts.length > 0 ? 2 : 0);

  return {
    ...candidate,
    selectionScore,
  };
}

function finalizeLead(candidate, queryTokens) {
  const uniqueContacts = dedupeContacts(candidate.contacts)
    .map((contact) => ({
      name: contact.name || "",
      title: contact.title || "",
      company: contact.company || candidate.name || "",
      email: contact.email || "",
      phone: contact.phone || "",
      sourceUrl: contact.sourceUrl || "",
      confidence: contact.confidence || "medium",
    }))
    .filter((contact) => contact.name || contact.email || contact.phone)
    .slice(0, 6);

  const sourceUrls = Array.from(candidate.sourceUrls).slice(0, 8);
  const emails = Array.from(candidate.emails).slice(0, 6);
  const phones = Array.from(candidate.phones).slice(0, 6);
  const sourceTypes = Array.from(candidate.sourceTypes);

  const finalScore =
    candidate.selectionScore +
    (emails.length > 0 ? 4 : 0) +
    (phones.length > 0 ? 4 : 0) +
    (uniqueContacts.length > 0 ? 5 : 0) +
    scoreTextAgainstTokens(candidate.name, queryTokens);

  const confidence = finalScore >= 18 ? "high" : finalScore >= 11 ? "medium" : "low";

  return {
    name: candidate.name || candidate.officialWebsite || "Unnamed lead",
    website: candidate.officialWebsite || "",
    address: candidate.address || "",
    emails,
    phones,
    contacts: uniqueContacts,
    sourceTypes,
    sourceUrls,
    description: truncate(candidate.descriptions[0] || "", 240),
    confidence,
    finalScore,
  };
}

function dedupeContacts(contacts) {
  const seen = new Set();
  const unique = [];
  for (const contact of contacts) {
    const key = [
      normalizeComparableText(contact.name),
      normalizeComparableText(contact.title),
      normalizeComparableText(contact.email),
      normalizeComparableText(contact.phone),
      normalizeComparableText(contact.company),
    ].join("|");
    if (!key.replace(/\|/g, "")) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(contact);
  }
  return unique;
}

function addContact(contactList, contact) {
  if (!contact) return;
  contactList.push({
    name: normalizeWhitespace(contact.name),
    title: normalizeWhitespace(contact.title),
    company: normalizeWhitespace(contact.company || contact.sourceCompany),
    email: normalizeWhitespace(contact.email),
    phone: normalizeWhitespace(contact.phone),
    sourceUrl: contact.sourceUrl || "",
    confidence: contact.confidence || "medium",
  });
}

function extractEmails(text) {
  const emails = new Set();
  const matches = String(text || "").matchAll(EMAIL_REGEX);
  for (const match of matches) {
    const email = String(match[1] || "").trim().replace(/[)>.,;]+$/, "").toLowerCase();
    if (!email) continue;
    if (/example\.(com|org|net)$/i.test(email)) continue;
    if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(email)) continue;
    emails.add(email);
  }
  return Array.from(emails);
}

function normalizePhone(rawPhone) {
  const cleaned = normalizeWhitespace(rawPhone).replace(/[;,]+$/g, "");
  const digitCount = (cleaned.match(/\d/g) || []).length;
  if (digitCount < 7 || digitCount > 18) return "";
  return cleaned;
}

function extractPhones(text) {
  const phones = new Set();
  const matches = String(text || "").matchAll(PHONE_REGEX);
  for (const match of matches) {
    const phone = normalizePhone(match[0]);
    if (!phone) continue;
    phones.add(phone);
  }
  return Array.from(phones);
}

function looksLikePersonName(value) {
  const text = normalizeWhitespace(value);
  if (!text) return false;
  if (/\b(inc|llc|ltd|limited|pty|corp|company|group|solutions|services|agency|partners|plumbing|electrical|clinic|lawyers?)\b/i.test(text)) {
    return false;
  }
  const words = text.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => /^[A-Z][a-z'’-]+$/.test(word));
}

function extractPeopleFromSearchResult(result) {
  const contacts = [];
  const title = normalizeWhitespace(result?.title || "");
  const description = normalizeWhitespace(result?.description || "");
  const sourceUrl = result?.url || "";
  const hostname = getHostname(sourceUrl);

  const parts = title.split(TITLE_SPLIT_REGEX).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2 && looksLikePersonName(parts[0])) {
    contacts.push({
      name: parts[0],
      title: parts[1] || "",
      company: parts[2] || deriveCompanyFromDescription(description),
      sourceUrl,
      confidence: hostname.includes("linkedin.com") ? "high" : "medium",
    });
  }

  const fallbackNameMatches = Array.from(description.matchAll(NAME_REGEX)).map((match) => match[1]).filter(looksLikePersonName);
  const titleMatch = ROLE_KEYWORDS.map((keyword) => new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i")).find((regex) => regex.test(description));
  if (contacts.length === 0 && fallbackNameMatches.length > 0 && titleMatch) {
    contacts.push({
      name: fallbackNameMatches[0],
      title: titleMatch.source.replace(/\\b|\\/g, "").replace(/\^|\$/g, ""),
      company: deriveCompanyFromDescription(description),
      sourceUrl,
      confidence: "low",
    });
  }

  return dedupeContacts(contacts);
}

function deriveCompanyFromDescription(description) {
  const text = normalizeWhitespace(description);
  if (!text) return "";
  const fragments = text.split(/[|,]/).map((fragment) => fragment.trim()).filter(Boolean);
  return truncate(fragments[0] || "", 100);
}

function findCandidateForPerson(candidateMap, person, fallbackCandidate, queryTokens) {
  const companyMatch = findBestCompanyMatch(candidateMap, person.company || person.sourceCompany || "", queryTokens);
  if (companyMatch) return companyMatch;
  return fallbackCandidate || null;
}

function findBestCompanyMatch(candidateMap, companyName, queryTokens) {
  const target = normalizeComparableText(companyName);
  if (!target) return null;

  let bestCandidate = null;
  let bestScore = 0;
  for (const candidate of candidateMap.values()) {
    const comparison = normalizeComparableText(candidate.name);
    if (!comparison) continue;
    let score = 0;
    if (comparison === target) score += 6;
    if (comparison.includes(target) || target.includes(comparison)) score += 4;
    score += scoreTextAgainstTokens(`${candidate.name} ${companyName}`, queryTokens);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestScore >= 4 ? bestCandidate : null;
}

async function fetchBravePoiDetails(ids) {
  const url = new URL("https://api.search.brave.com/res/v1/local/pois");
  for (const id of ids) url.searchParams.append("ids", id);

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": config.braveApiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Brave Local POIs API error ${response.status}: ${response.statusText}. ${body}`);
  }

  const data = await response.json();
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.pois)) return data.pois;
  return [];
}

function parsePoiLikeObject(poi) {
  const emails = extractEmails(JSON.stringify(poi));
  const phones = new Set();
  for (const key of ["phone", "telephone", "phone_number", "phone_numbers", "display_phone", "phones"]) {
    for (const value of collectValuesForKey(poi, key)) {
      if (typeof value === "string") {
        for (const phone of extractPhones(value)) phones.add(phone);
      } else if (Array.isArray(value)) {
        for (const nested of value) {
          if (typeof nested === "string") {
            for (const phone of extractPhones(nested)) phones.add(phone);
          } else if (nested && typeof nested === "object") {
            for (const phone of extractPhones(JSON.stringify(nested))) phones.add(phone);
          }
        }
      }
    }
  }

  const name = firstNonEmpty([
    ...collectValuesForKey(poi, "name"),
    ...collectValuesForKey(poi, "title"),
  ]);

  const website = firstUrl([
    ...collectValuesForKey(poi, "website"),
    ...collectValuesForKey(poi, "website_url"),
    ...collectValuesForKey(poi, "url"),
  ]);

  const address = firstNonEmpty([
    ...collectValuesForKey(poi, "formatted_address"),
    ...collectValuesForKey(poi, "address"),
    ...collectValuesForKey(poi, "full_address"),
  ]);

  const category = firstNonEmpty([
    ...collectValuesForKey(poi, "category"),
    ...collectValuesForKey(poi, "categories"),
    ...collectValuesForKey(poi, "type"),
  ]);

  return {
    name,
    website,
    address,
    category,
    emails,
    phones: Array.from(phones),
  };
}

function collectValuesForKey(value, targetKey) {
  const matches = [];
  const normalizedTarget = targetKey.toLowerCase();

  function visit(node) {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    if (!node || typeof node !== "object") return;

    for (const [key, child] of Object.entries(node)) {
      if (key.toLowerCase() === normalizedTarget) {
        matches.push(child);
      }
      visit(child);
    }
  }

  visit(value);
  return matches;
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (typeof value === "string" && normalizeWhitespace(value)) return normalizeWhitespace(value);
    if (value && typeof value === "object") {
      const serialized = normalizeWhitespace(JSON.stringify(value));
      if (serialized && serialized !== "{}") return serialized;
    }
  }
  return "";
}

function firstUrl(values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (/^https?:\/\//i.test(value)) return value;
  }
  return "";
}

async function fetchAndExtractPage(url) {
  try {
    const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    if (!/html|xml|text/i.test(contentType)) return null;

    const body = await response.text();
    return extractPageSignals(response.url || url, body);
  } catch (error) {
    log("debug", `Lead research fetch failed for ${url}: ${error.message}`);
    return null;
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      headers: {
        "User-Agent": CONNECTOR_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractPageSignals(pageUrl, html) {
  const $ = cheerio.load(html, { decodeEntities: true });
  $("script:not([type='application/ld+json']), style, noscript").remove();
  $("br").replaceWith("\n");

  const title = normalizeWhitespace($("title").first().text());
  const metaDescription = normalizeWhitespace($("meta[name='description']").attr("content") || "");
  const bodyText = normalizeWhitespace($("body").text());

  const emails = new Set([
    ...extractEmails(bodyText),
    ...extractEmails($.html()),
  ]);
  const phones = new Set(extractPhones(bodyText));
  const contacts = [];

  $("a[href^='mailto:']").each((_index, element) => {
    const href = $(element).attr("href") || "";
    const email = href.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
    if (email) emails.add(email);

    const block = normalizeWhitespace($(element).closest("li, article, section, div, p").text());
    const candidateContact = parseContactBlock(block, pageUrl, { email });
    if (candidateContact) addContact(contacts, candidateContact);
  });

  $("a[href^='tel:']").each((_index, element) => {
    const href = $(element).attr("href") || "";
    const phone = normalizePhone(href.replace(/^tel:/i, ""));
    if (phone) phones.add(phone);

    const block = normalizeWhitespace($(element).closest("li, article, section, div, p").text());
    const candidateContact = parseContactBlock(block, pageUrl, { phone });
    if (candidateContact) addContact(contacts, candidateContact);
  });

  const structuredData = parseStructuredData($, pageUrl);
  for (const email of structuredData.emails) emails.add(email);
  for (const phone of structuredData.phones) phones.add(phone);
  for (const contact of structuredData.contacts) addContact(contacts, contact);

  const textContacts = extractContactsFromDom($, pageUrl);
  for (const contact of textContacts) addContact(contacts, contact);

  const relevantLinks = collectRelevantLinks($, pageUrl);
  const organizationName = structuredData.organizationName || detectOrganizationName(title, bodyText);
  const address = structuredData.address || extractAddress(bodyText);

  return {
    pageUrl,
    pageTitle: title,
    description: metaDescription || truncate(bodyText, 220),
    organizationName,
    address,
    emails: Array.from(emails),
    phones: Array.from(phones),
    contacts: dedupeContacts(contacts),
    relevantLinks,
  };
}

function parseStructuredData($, pageUrl) {
  const contacts = [];
  const emails = new Set();
  const phones = new Set();
  let organizationName = "";
  let address = "";

  $("script[type='application/ld+json']").each((_index, element) => {
    const raw = $(element).contents().text().trim();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      walkStructuredData(parsed, (node) => {
        const nodeType = normalizeComparableText(node?.["@type"] || node?.type || "");
        const nodeName = normalizeWhitespace(node?.name || node?.legalName || "");
        const nodeEmail = normalizeWhitespace(node?.email || "").toLowerCase();
        const nodePhone = normalizePhone(node?.telephone || node?.phone || "");
        const nodeTitle = normalizeWhitespace(node?.jobTitle || node?.title || "");
        const nodeCompany = normalizeWhitespace(node?.worksFor?.name || node?.memberOf?.name || "");
        const nodeAddress = parseAddressNode(node?.address || node?.location?.address || "");

        if (!organizationName && /organization|localbusiness|corporation|online ?store|professionalservice|homeandconstructionbusiness|medicalbusiness|legalservice/i.test(nodeType)) {
          organizationName = nodeName;
        }
        if (!address && nodeAddress) address = nodeAddress;
        if (nodeEmail) emails.add(nodeEmail);
        if (nodePhone) phones.add(nodePhone);

        if (/person/i.test(nodeType) || (nodeName && nodeTitle)) {
          const contact = {
            name: nodeName,
            title: nodeTitle,
            company: nodeCompany,
            email: nodeEmail,
            phone: nodePhone,
            sourceUrl: pageUrl,
            confidence: "high",
          };
          if (contact.name || contact.email || contact.phone) addContact(contacts, contact);
        }

        const contactPoints = Array.isArray(node?.contactPoint)
          ? node.contactPoint
          : node?.contactPoint
            ? [node.contactPoint]
            : [];
        for (const contactPoint of contactPoints) {
          const email = normalizeWhitespace(contactPoint?.email || "").toLowerCase();
          const phone = normalizePhone(contactPoint?.telephone || "");
          const title = normalizeWhitespace(contactPoint?.contactType || "");
          if (email) emails.add(email);
          if (phone) phones.add(phone);
          if (title || email || phone) {
            addContact(contacts, {
              name: "",
              title,
              company: organizationName,
              email,
              phone,
              sourceUrl: pageUrl,
              confidence: "high",
            });
          }
        }
      });
    } catch {
      // Ignore invalid JSON-LD blocks.
    }
  });

  return {
    organizationName,
    address,
    emails: Array.from(emails),
    phones: Array.from(phones),
    contacts: dedupeContacts(contacts),
  };
}

function walkStructuredData(value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) walkStructuredData(item, visitor);
    return;
  }

  if (!value || typeof value !== "object") return;
  visitor(value);

  for (const child of Object.values(value)) {
    walkStructuredData(child, visitor);
  }
}

function parseAddressNode(value) {
  if (!value) return "";
  if (typeof value === "string") return normalizeWhitespace(value);
  if (Array.isArray(value)) {
    return normalizeWhitespace(value.map((item) => parseAddressNode(item)).filter(Boolean).join(", "));
  }
  if (typeof value === "object") {
    const fields = [
      value.streetAddress,
      value.addressLocality,
      value.addressRegion,
      value.postalCode,
      value.addressCountry,
    ].filter(Boolean);
    return normalizeWhitespace(fields.join(", "));
  }
  return "";
}

function collectRelevantLinks($, pageUrl) {
  const urls = new Set();
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href") || "";
    const text = normalizeComparableText($(element).text());
    const hrefText = normalizeComparableText(href);
    const combined = `${text} ${hrefText}`;
    if (!CONTACT_LINK_HINTS.some((hint) => combined.includes(hint))) return;

    try {
      const absoluteUrl = new URL(href, pageUrl).toString();
      if (/^mailto:|^tel:/i.test(absoluteUrl)) return;
      urls.add(stripHash(absoluteUrl));
    } catch {
      // Ignore malformed link.
    }
  });

  return Array.from(urls).slice(0, 12);
}

function extractContactsFromDom($, pageUrl) {
  const contacts = [];
  const selectors = ["li", "article", "section", "div", "p"];

  for (const selector of selectors) {
    $(selector).each((_index, element) => {
      const text = normalizeWhitespace($(element).text());
      if (text.length < 20 || text.length > 400) return;
      const hasRole = ROLE_KEYWORDS.some((keyword) => new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i").test(text));
      const hasEmailOrPhone = extractEmails(text).length > 0 || extractPhones(text).length > 0;
      if (!hasRole && !hasEmailOrPhone) return;

      const contact = parseContactBlock(text, pageUrl, {});
      if (contact) addContact(contacts, contact);
    });
  }

  return dedupeContacts(contacts);
}

function parseContactBlock(text, sourceUrl, overrides = {}) {
  const normalizedText = normalizeWhitespace(text);
  if (!normalizedText) return null;

  const emails = overrides.email ? [overrides.email] : extractEmails(normalizedText);
  const phones = overrides.phone ? [overrides.phone] : extractPhones(normalizedText);
  const names = Array.from(normalizedText.matchAll(NAME_REGEX)).map((match) => match[1]).filter(looksLikePersonName);

  const title = ROLE_KEYWORDS.find((keyword) => new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i").test(normalizedText)) || "";
  if (!title && names.length === 0 && emails.length === 0 && phones.length === 0) return null;

  return {
    name: names[0] || "",
    title,
    email: emails[0] || "",
    phone: phones[0] || "",
    sourceUrl,
    confidence: names[0] && title ? "medium" : "low",
  };
}

function detectOrganizationName(title, bodyText) {
  const titlePieces = normalizeWhitespace(title)
    .split(TITLE_SPLIT_REGEX)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (titlePieces.length > 0) return cleanBusinessName(titlePieces[0]);

  const heading = normalizeWhitespace(bodyText).split(/[.!?]/)[0] || "";
  return cleanBusinessName(heading);
}

function extractAddress(text) {
  const match = String(text || "").match(/\b\d{1,6}\s+[A-Za-z0-9.'\-\s]+,\s*[A-Za-z.'\-\s]+,\s*[A-Z]{2,3}\s+\d{3,6}\b/);
  return match ? normalizeWhitespace(match[0]) : "";
}

function mergePageSignalsIntoCandidate(candidate, pageSignals) {
  if (!pageSignals) return;
  if (!candidate.name && pageSignals.organizationName) candidate.name = pageSignals.organizationName;
  if (!candidate.address && pageSignals.address) candidate.address = pageSignals.address;
  if (pageSignals.pageUrl) {
    candidate.pageUrls.add(pageSignals.pageUrl);
    candidate.sourceUrls.add(pageSignals.pageUrl);
  }
  if (pageSignals.pageTitle || pageSignals.description) {
    candidate.descriptions.push(truncate(`${pageSignals.pageTitle || ""} ${pageSignals.description || ""}`, 260));
  }
  for (const email of pageSignals.emails || []) candidate.emails.add(email);
  for (const phone of pageSignals.phones || []) candidate.phones.add(phone);
  for (const contact of pageSignals.contacts || []) addContact(candidate.contacts, contact);
}

async function discoverRelevantSitemapUrls(baseUrl) {
  if (!baseUrl) return [];

  let sitemapUrl;
  try {
    sitemapUrl = new URL("/sitemap.xml", baseUrl).toString();
  } catch {
    return [];
  }

  const urls = new Set();

  try {
    const rootSitemap = await fetchWithTimeout(sitemapUrl, FETCH_TIMEOUT_MS);
    if (!rootSitemap.ok) return [];
    const xml = await rootSitemap.text();
    const initialUrls = parseRelevantUrlsFromSitemapXml(xml);
    for (const url of initialUrls.pageUrls) urls.add(url);

    const nestedSitemaps = initialUrls.sitemapUrls.slice(0, 2);
    const nestedResults = await Promise.allSettled(
      nestedSitemaps.map((nestedUrl) => fetchWithTimeout(nestedUrl, FETCH_TIMEOUT_MS).then((response) => response.ok ? response.text() : ""))
    );

    for (const result of nestedResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const nested = parseRelevantUrlsFromSitemapXml(result.value);
      for (const url of nested.pageUrls) urls.add(url);
    }
  } catch (error) {
    log("debug", `Lead research sitemap discovery failed for ${baseUrl}: ${error.message}`);
  }

  return Array.from(urls).slice(0, 6);
}

function parseRelevantUrlsFromSitemapXml(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const pageUrls = [];
  const sitemapUrls = [];

  $("url > loc").each((_index, element) => {
    const value = normalizeWhitespace($(element).text());
    const normalized = normalizeComparableText(value);
    if (CONTACT_LINK_HINTS.some((hint) => normalized.includes(hint))) {
      pageUrls.push(value);
    }
  });

  $("sitemap > loc").each((_index, element) => {
    const value = normalizeWhitespace($(element).text());
    sitemapUrls.push(value);
  });

  return {
    pageUrls,
    sitemapUrls,
  };
}

function buildDomainSpecificQuery(officialWebsite) {
  const registrableDomain = getRegistrableDomain(officialWebsite);
  return `site:${registrableDomain} (contact OR team OR leadership OR email OR phone OR owner OR founder)`;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatLeadSection(query, leads, stats) {
  if (!Array.isArray(leads) || leads.length === 0) {
    return [
      `Lead enrichment summary for "${query}"`,
      "No qualified leads with usable contact information were found from the researched sources.",
      "Sources checked: standard web search results, official websites, contact pages, leadership pages, sitemap discovery, structured data, directory listings, and public profile snippets.",
    ].join("\n\n");
  }

  const header = [
    `Lead enrichment summary for "${query}"`,
    `Qualified leads: ${stats.total}`,
    `Coverage: ${stats.withEmail} with email, ${stats.withPhone} with phone, ${stats.withNamedContacts} with named contacts`,
    "Sources used: web search results, official websites, contact/about/team pages, structured data, sitemap discovery, public directory listings, and public profile snippets.",
  ].join("\n");

  const leadBlocks = leads.map((lead, index) => {
    const lines = [`[${index + 1}] ${lead.name}`];
    if (lead.website) lines.push(`Website: ${lead.website}`);
    if (lead.address) lines.push(`Address: ${lead.address}`);
    if (lead.phones.length > 0) lines.push(`Phones: ${lead.phones.join(", ")}`);
    if (lead.emails.length > 0) lines.push(`Emails: ${lead.emails.join(", ")}`);
    if (lead.contacts.length > 0) {
      lines.push("Named contacts:");
      for (const contact of lead.contacts.slice(0, 4)) {
        const details = [contact.name || "Unnamed contact"];
        if (contact.title) details.push(contact.title);
        if (contact.email) details.push(contact.email);
        if (contact.phone) details.push(contact.phone);
        if (contact.sourceUrl) details.push(contact.sourceUrl);
        lines.push(`- ${details.join(" | ")}`);
      }
    }
    if (lead.description) lines.push(`Notes: ${lead.description}`);
    if (lead.sourceUrls.length > 0) {
      lines.push(`Sources: ${lead.sourceUrls.slice(0, 4).join(", ")}`);
    }
    lines.push(`Confidence: ${lead.confidence}`);
    return lines.join("\n");
  });

  return `${header}\n\n${leadBlocks.join("\n\n---\n\n")}`;
}
