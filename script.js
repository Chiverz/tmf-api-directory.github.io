const API_URL = "./index.json";

const state = {
    documents: [],
    filtered: [],
    documentMap: new Map(),
    currentPage: 1,
    pageSize: 10,
    searchTerm: "",
    currentSort: "name",
    activeCategory: "all",
    activeDomain: "all",
    apiSource: API_URL,
    route: { view: "index", id: null }
};

const elements = {
    body: document.body,
    search: document.getElementById("searchInput"),
    category: document.getElementById("categorySelect"),
    domain: document.getElementById("domainSelect"),
    sort: document.getElementById("sortSelect"),
    toolbar: document.querySelector(".toolbar"),
    themeToggle: document.getElementById("themeToggle"),
    statusBanner: document.getElementById("statusBanner"),
    statusMessage: document.querySelector(".status-message"),
    spinner: document.querySelector(".status-banner .spinner"),
    breadcrumb: document.getElementById("breadcrumb"),
    indexView: document.getElementById("indexView"),
    cardGrid: document.getElementById("cardGrid"),
    resultsSummary: document.getElementById("resultsSummary"),
    resultCount: document.getElementById("resultCount"),
    pagination: document.getElementById("pagination"),
    pageInfo: document.getElementById("pageInfo"),
    prevPage: document.getElementById("prevPage"),
    nextPage: document.getElementById("nextPage"),
    detailView: document.getElementById("detailView")
};

document.addEventListener("DOMContentLoaded", () => {
    attachEventListeners();
    applySavedTheme();
    updateBreadcrumb();
    window.addEventListener("hashchange", handleRouteChange);
    fetchResources().finally(() => handleRouteChange());
});

function attachEventListeners() {
    elements.search?.addEventListener("input", (event) => {
        state.searchTerm = event.target.value.trim().toLowerCase();
        state.currentPage = 1;
        applyFilters();
    });

    elements.category?.addEventListener("change", (event) => {
        state.activeCategory = event.target.value;
        state.currentPage = 1;
        applyFilters();
    });

    elements.domain?.addEventListener("change", (event) => {
        state.activeDomain = event.target.value;
        state.currentPage = 1;
        applyFilters();
    });

    elements.sort?.addEventListener("change", (event) => {
        state.currentSort = event.target.value;
        state.currentPage = 1;
        applyFilters();
    });

    elements.prevPage?.addEventListener("click", () => {
        if (state.currentPage > 1) {
            state.currentPage -= 1;
            renderRoute();
        }
    });

    elements.nextPage?.addEventListener("click", () => {
        const totalPages = Math.ceil(state.filtered.length / state.pageSize) || 1;
        if (state.currentPage < totalPages) {
            state.currentPage += 1;
            renderRoute();
        }
    });

    elements.themeToggle?.addEventListener("click", toggleTheme);
}

function getApiSources() {
    return [
        API_URL,
        `https://corsproxy.io/?${encodeURIComponent(API_URL)}`,
        `https://r.jina.ai/${API_URL}`
    ];
}

async function loadPayload() {
    let lastError = null;

    for (const source of getApiSources()) {
        try {
            const response = await fetch(source, { mode: "cors" });
            if (!response.ok) {
                throw new Error(`Request failed with ${response.status}`);
            }

            const body = await response.text();
            const data = JSON.parse(body);
            return { data, source };
        } catch (error) {
            lastError = error;
            console.warn(`Failed to fetch TMF resources from ${source}`, error);
        }
    }

    throw lastError || new Error("Unable to reach TMF resource index.");
}

async function fetchResources() {
    setStatus("Loading resources...", false);
    toggleSpinner(true);

    try {
        const { data, source } = await loadPayload();
        state.apiSource = source;
        state.documents = normaliseResources(data);
        state.documentMap = new Map(state.documents.map((doc) => [doc.id, doc]));
        state.currentPage = 1;
        populateCategories(state.documents);
        populateDomains(state.documents);
        applyFilters();

        if (source !== API_URL) {
            setStatus("Loaded via compatibility proxy because the TMF bucket blocks cross-origin requests.", false);
        } else {
            setStatus("", false, true);
        }
    } catch (error) {
        console.error(error);
        setStatus("Unable to load resources right now. Please try again later.", true);
    } finally {
        toggleSpinner(false);
    }
}

function normaliseResources(payload) {
    const documentsByKey = new Map();

    Object.entries(payload || {}).forEach(([categoryName, groupedResources]) => {
        Object.values(groupedResources || {}).forEach((entries) => {
            entries.forEach((entry) => {
                const documentNumber = entry?.document_number || entry?.api_description?.api_name || entry?.options?.[0]?.name || "Untitled";
                const apiName = entry?.api_description?.api_name || documentNumber;
                const key = documentNumber || apiName;

                if (!documentsByKey.has(key)) {
                    documentsByKey.set(key, {
                        key,
                        documentNumber,
                        apiName,
                        description: entry?.api_description?.api_description || "",
                        categories: new Set(),
                        contexts: new Set(),
                        lifecycle: new Set(),
                        versions: new Map()
                    });
                }

                const doc = documentsByKey.get(key);
                if (!doc.description && entry?.api_description?.api_description) {
                    doc.description = entry.api_description.api_description;
                }

                if (categoryName) {
                    doc.categories.add(categoryName);
                }

                if (entry?.context) {
                    String(entry.context)
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean)
                        .forEach((contextValue) => doc.contexts.add(contextValue));
                }

                if (entry?.lifecycle_status) {
                    doc.lifecycle.add(entry.lifecycle_status);
                }

                const versionKey = entry?.version_info || "Unversioned";
                if (!doc.versions.has(versionKey)) {
                    doc.versions.set(versionKey, {
                        version: entry?.version_info || "Unversioned",
                        release: entry?.release_info || "",
                        lifecycle: entry?.lifecycle_status || "",
                        published: entry?.published_date || "",
                        notes: entry?.notes || "",
                        options: []
                    });
                }

                const version = doc.versions.get(versionKey);
                if (!version.release && entry?.release_info) {
                    version.release = entry.release_info;
                }
                if (!version.lifecycle && entry?.lifecycle_status) {
                    version.lifecycle = entry.lifecycle_status;
                }
                if (!version.published && entry?.published_date) {
                    version.published = entry.published_date;
                }
                if (!version.notes && entry?.notes) {
                    version.notes = entry.notes;
                }

                (entry?.options || []).forEach((option) => {
                    version.options.push({
                        type: option?.type || "",
                        name: option?.name || "Download",
                        downloadUrl: option?.download || "",
                        default: option?.default || "",
                        icon: option?.icon || ""
                    });
                });
            });
        });
    });

    const usedSlugs = new Set();
    const documents = [];

    documentsByKey.forEach((doc, key) => {
        let slug = createSlug(key);
        while (usedSlugs.has(slug)) {
            slug = `${slug}-${usedSlugs.size + 1}`;
        }
        usedSlugs.add(slug);

        const versions = Array.from(doc.versions.values());
        versions.sort((a, b) => {
            const dateDiff = parseDate(b.published) - parseDate(a.published);
            if (dateDiff !== 0) {
                return dateDiff;
            }
            return compareStrings(b.version, a.version);
        });

        const optionTypes = new Set();
        versions.forEach((version) => {
            version.options.sort((a, b) => compareStrings(a.type, b.type) || compareStrings(a.name, b.name));
            version.options.forEach((option) => {
                if (option.type) {
                    optionTypes.add(option.type);
                }
            });
        });

        const optionTypesList = Array.from(optionTypes).sort((a, b) => compareStrings(a, b));
        const contextsList = Array.from(doc.contexts).sort((a, b) => compareStrings(a, b));
        const latestPublished = versions.reduce((acc, version) => Math.max(acc, parseDate(version.published)), 0);
        const searchParts = [
            doc.documentNumber,
            doc.apiName,
            doc.description,
            Array.from(doc.categories).join(" "),
            contextsList.join(" "),
            Array.from(doc.lifecycle).join(" "),
            versions.map((version) => version.version).join(" "),
            optionTypesList.join(" ")
        ];
        const searchIndex = stripHtml(searchParts.join(" ")).toLowerCase();

        documents.push({
            id: slug,
            key,
            documentNumber: doc.documentNumber || key,
            apiName: doc.apiName || doc.documentNumber || key,
            description: doc.description,
            categories: Array.from(doc.categories).sort((a, b) => compareStrings(a, b)),
            contexts: contextsList,
            lifecycle: Array.from(doc.lifecycle).sort((a, b) => compareStrings(a, b)),
            versions,
            optionTypes: optionTypesList,
            primaryType: optionTypesList[0] || "",
            latestPublished,
            searchIndex
        });
    });

    documents.sort((a, b) => compareStrings(a.documentNumber, b.documentNumber) || compareStrings(a.apiName, b.apiName));

    return documents;
}

function handleRouteChange() {
    const previousRoute = state.route;
    state.route = parseHash();

    if (previousRoute.view !== state.route.view) {
        state.currentPage = 1;
    }

    renderRoute();
}

function parseHash() {
    const hash = window.location.hash.replace(/^#/, "").trim();
    if (!hash || hash === "/") {
        return { view: "index", id: null };
    }

    const parts = hash.split("/").filter(Boolean);
    if (parts[0] === "document" && parts[1]) {
        return { view: "detail", id: decodeURIComponent(parts[1]) };
    }

    return { view: "index", id: null };
}

function renderRoute() {
    const isDetail = state.route.view === "detail";

    if (elements.detailView) {
        elements.detailView.hidden = !isDetail;
    }

    elements.body.classList.toggle("view-detail", isDetail);

    if (!state.documents.length) {
        updateBreadcrumb();
        renderIndex();
        return;
    }

    if (isDetail) {
        const doc = state.documentMap.get(state.route.id);
        if (!doc) {
            setStatus("The requested API could not be found.", true);
            navigateToIndex();
            return;
        }

        if (!state.filtered.some((item) => item.id === state.route.id)) {
            navigateToIndex();
            return;
        }

        renderDetail(doc);
        updateBreadcrumb(doc);
    } else {
        if (elements.detailView) {
            elements.detailView.innerHTML = "";
        }
        updateBreadcrumb();
    }

    renderIndex();
}

function renderIndex() {
    const totalItems = state.filtered.length;
    const totalPages = totalItems ? Math.ceil(totalItems / state.pageSize) : 0;

    if (totalPages && state.currentPage > totalPages) {
        state.currentPage = totalPages;
    }
    if (!totalPages) {
        state.currentPage = 1;
    }

    const startIndex = (state.currentPage - 1) * state.pageSize;
    const pageItems = totalItems ? state.filtered.slice(startIndex, startIndex + state.pageSize) : [];

    if (elements.cardGrid) {
        elements.cardGrid.innerHTML = "";
        elements.cardGrid.setAttribute("aria-busy", "false");
    }

    if (!totalItems) {
        if (elements.cardGrid) {
            elements.cardGrid.innerHTML = `<div class="empty-state">No APIs match your filters yet.</div>`;
        }
        updateSummary(0);
        if (elements.pagination) {
            elements.pagination.hidden = true;
        }
        return;
    }

    const fragment = document.createDocumentFragment();
    const isDetail = state.route.view === "detail";

    pageItems.forEach((doc) => {
        const card = document.createElement("article");
        card.className = "doc-card";
        if (isDetail && state.route.id === doc.id) {
            card.classList.add("doc-card--active");
        }
        card.tabIndex = 0;
        card.setAttribute("role", "link");
        card.setAttribute("aria-label", `${doc.documentNumber}: ${doc.apiName}`);

        const number = document.createElement("span");
        number.className = "doc-card__number";
        number.textContent = doc.documentNumber;

        const name = document.createElement("h2");
        name.className = "doc-card__name";
        name.textContent = doc.apiName;

        const meta = document.createElement("div");
        meta.className = "doc-card__meta";
        meta.appendChild(createBadge(`${doc.versions.length} version${doc.versions.length === 1 ? "" : "s"}`));

        card.append(number, name, meta);

        if (doc.contexts.length) {
            const contextsRow = document.createElement("div");
            contextsRow.className = "doc-card__contexts";
            doc.contexts.forEach((contextValue) => {
                contextsRow.appendChild(createBadge(contextValue));
            });
            card.appendChild(contextsRow);
        }

        card.addEventListener("click", () => navigateToDocument(doc));
        card.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                navigateToDocument(doc);
            }
        });

        fragment.appendChild(card);
    });

    elements.cardGrid?.appendChild(fragment);
    updateSummary(totalItems);
    renderPagination(totalPages, totalItems);
}

function renderDetail(doc) {
    if (!elements.detailView) {
        return;
    }

    elements.detailView.innerHTML = "";

    const container = document.createElement("article");
    container.className = "detail-card";

    const header = document.createElement("header");
    header.className = "detail-card__header";

    const docNumber = document.createElement("span");
    docNumber.className = "detail-card__number";
    docNumber.textContent = doc.documentNumber;

    const title = document.createElement("h2");
    title.className = "detail-card__title";
    title.textContent = doc.apiName;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "detail-card__close";
    closeButton.setAttribute("aria-label", "Close detail view");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => navigateToIndex());

    header.append(docNumber, title, closeButton);
    container.appendChild(header);

    const badgeRow = document.createElement("div");
    badgeRow.className = "badge-row";
    doc.categories.forEach((category) => badgeRow.appendChild(createBadge(category)));
    doc.contexts.forEach((contextValue) => badgeRow.appendChild(createBadge(contextValue)));
    doc.lifecycle.forEach((status) => badgeRow.appendChild(createBadge(status)));
    if (badgeRow.childElementCount) {
        container.appendChild(badgeRow);
    }

    if (doc.description) {
        const description = document.createElement("p");
        description.className = "detail-card__description";
        description.textContent = stripHtml(doc.description);
        container.appendChild(description);
    }

    const meta = document.createElement("dl");
    meta.className = "detail-meta";
    appendMeta(meta, "Download types", doc.optionTypes.join(", "));

    const latestVersion = doc.versions[0];
    if (latestVersion) {
        appendMeta(meta, "Latest version", latestVersion.version);
        appendMeta(meta, "Latest release", latestVersion.release);
        appendMeta(meta, "Latest published", latestVersion.published);
    }

    appendMeta(meta, "Available versions", doc.versions.length ? `${doc.versions.length}` : "");
    appendMeta(meta, "Data source", state.apiSource === API_URL ? "TMF repository" : "Compatibility proxy");

    if (meta.childElementCount) {
        container.appendChild(meta);
    }

    const versionHeading = document.createElement("h3");
    versionHeading.className = "detail-card__section-title";
    versionHeading.textContent = "Downloadable assets by version";
    container.appendChild(versionHeading);

    const versionsWrapper = document.createElement("div");
    versionsWrapper.className = "version-list";

    doc.versions.forEach((version) => {
        const versionCard = document.createElement("section");
        versionCard.className = "version-card";

        const versionHeader = document.createElement("header");
        versionHeader.className = "version-card__header";

        const versionTitle = document.createElement("h4");
        versionTitle.textContent = version.version;
        versionHeader.appendChild(versionTitle);

        const versionMeta = document.createElement("div");
        versionMeta.className = "version-card__meta";
        appendMetaText(versionMeta, "Release", version.release);
        appendMetaText(versionMeta, "Published", version.published);
        appendMetaText(versionMeta, "Status", version.lifecycle);
        versionHeader.appendChild(versionMeta);

        versionCard.appendChild(versionHeader);

        if (version.notes) {
            const notes = document.createElement("p");
            notes.className = "version-card__notes";
            notes.textContent = stripHtml(version.notes);
            versionCard.appendChild(notes);
        }

        const downloads = document.createElement("ul");
        downloads.className = "download-list";

        if (!version.options.length) {
            const empty = document.createElement("li");
            empty.className = "download-item download-item--empty";
            empty.textContent = "No downloads available for this version yet.";
            downloads.appendChild(empty);
        } else {
            version.options.forEach((option) => {
                const item = document.createElement("li");
                item.className = "download-item";

                const info = document.createElement("div");
                info.className = "download-info";

                if (option.type) {
                    info.appendChild(createBadge(option.type));
                }

                const name = document.createElement("span");
                name.className = "download-name";
                name.textContent = option.name;
                info.appendChild(name);

                item.appendChild(info);

                if (option.downloadUrl) {
                    const link = document.createElement("a");
                    link.className = "download-button";
                    link.href = option.downloadUrl;
                    link.target = "_blank";
                    link.rel = "noopener";
                    link.download = "";
                    link.textContent = "Download";
                    item.appendChild(link);
                }

                downloads.appendChild(item);
            });
        }

        versionCard.appendChild(downloads);
        versionsWrapper.appendChild(versionCard);
    });

    container.appendChild(versionsWrapper);
    elements.detailView.appendChild(container);
}

function applyFilters() {
    const filtered = state.documents.filter((doc) => {
        const matchesCategory = state.activeCategory === "all" || doc.categories.includes(state.activeCategory);
        if (!matchesCategory) {
            return false;
        }

        const matchesDomain = state.activeDomain === "all" || doc.contexts.includes(state.activeDomain);
        if (!matchesDomain) {
            return false;
        }

        if (!state.searchTerm) {
            return true;
        }

        return doc.searchIndex.includes(state.searchTerm);
    });

    state.filtered = sortDocuments(filtered);

    const maxPages = Math.ceil(Math.max(state.filtered.length, 1) / state.pageSize);
    if (state.currentPage > maxPages) {
        state.currentPage = 1;
    }

    renderRoute();
}

function sortDocuments(items) {
    const sorted = [...items];

    switch (state.currentSort) {
        case "type":
            sorted.sort((a, b) => compareStrings(a.primaryType, b.primaryType) || compareStrings(a.apiName, b.apiName));
            break;
        case "date":
            sorted.sort((a, b) => b.latestPublished - a.latestPublished || compareStrings(a.apiName, b.apiName));
            break;
        case "name":
        default:
            sorted.sort((a, b) => compareStrings(a.apiName, b.apiName) || compareStrings(a.documentNumber, b.documentNumber));
            break;
    }

    return sorted;
}

function renderPagination(totalPages, totalItems) {
    if (!elements.pagination) {
        return;
    }

    if (!totalItems || totalPages <= 1) {
        elements.pagination.hidden = true;
        return;
    }

    elements.pagination.hidden = false;
    elements.prevPage.disabled = state.currentPage === 1;
    elements.nextPage.disabled = state.currentPage === totalPages;
    elements.pageInfo.textContent = `Page ${state.currentPage} of ${totalPages}`;
}

function updateSummary(totalItems) {
    if (!elements.resultCount || !elements.resultsSummary) {
        return;
    }

    elements.resultCount.textContent = totalItems.toString();
    elements.resultsSummary.hidden = false;
}

function populateCategories(documents) {
    if (!elements.category) {
        return;
    }

    const previousValue = elements.category.value;
    const categories = new Set();
    documents.forEach((doc) => {
        doc.categories.forEach((category) => {
            if (category) {
                categories.add(category);
            }
        });
    });

    const sortedCategories = Array.from(categories).sort((a, b) => compareStrings(a, b));
    const options = ["<option value=\"all\">All categories</option>"];
    sortedCategories.forEach((category) => {
        options.push(`<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`);
    });

    elements.category.innerHTML = options.join("");

    if (sortedCategories.includes(previousValue)) {
        elements.category.value = previousValue;
        state.activeCategory = previousValue;
    } else {
        elements.category.value = "all";
        state.activeCategory = "all";
    }
}

function populateDomains(documents) {
    if (!elements.domain) {
        return;
    }

    const previousValue = elements.domain.value;
    const domains = new Set();
    documents.forEach((doc) => {
        doc.contexts.forEach((contextValue) => {
            if (contextValue) {
                domains.add(contextValue);
            }
        });
    });

    const sortedDomains = Array.from(domains).sort((a, b) => compareStrings(a, b));
    const options = ["<option value=\"all\">All domains</option>"];
    sortedDomains.forEach((domain) => {
        options.push(`<option value="${escapeHtml(domain)}">${escapeHtml(domain)}</option>`);
    });

    elements.domain.innerHTML = options.join("");

    if (sortedDomains.includes(previousValue)) {
        elements.domain.value = previousValue;
        state.activeDomain = previousValue;
    } else {
        elements.domain.value = "all";
        state.activeDomain = "all";
    }
}

function setStatus(message, isError = false, hide = false) {
    if (!elements.statusBanner || !elements.statusMessage) {
        return;
    }

    if (hide) {
        elements.statusBanner.hidden = true;
        return;
    }

    elements.statusBanner.hidden = false;
    elements.statusMessage.textContent = message;
    elements.statusBanner.classList.toggle("status-error", isError);
}

function toggleSpinner(isActive) {
    if (elements.spinner) {
        elements.spinner.style.visibility = isActive ? "visible" : "hidden";
    }
    elements.cardGrid?.setAttribute("aria-busy", String(isActive));
}

function toggleTheme() {
    const isDark = elements.body.classList.toggle("theme-dark");
    elements.body.classList.toggle("theme-light", !isDark);
    elements.themeToggle.innerHTML = isDark ? '<span aria-hidden="true">&#127769;</span>' : '<span aria-hidden="true">&#9728;</span>';
    localStorage.setItem("tmf-theme", isDark ? "dark" : "light");
}

function applySavedTheme() {
    const savedTheme = localStorage.getItem("tmf-theme");
    if (!savedTheme) {
        return;
    }

    const isDark = savedTheme === "dark";
    elements.body.classList.toggle("theme-dark", isDark);
    elements.body.classList.toggle("theme-light", !isDark);
    elements.themeToggle.innerHTML = isDark ? '<span aria-hidden="true">&#127769;</span>' : '<span aria-hidden="true">&#9728;</span>';
}

function navigateToIndex() {
    if (window.location.hash === "#/" || window.location.hash === "" || window.location.hash === "#") {
        state.route = { view: "index", id: null };
        renderRoute();
    } else {
        window.location.hash = "#/";
    }
}

function navigateToDocument(doc) {
    const targetHash = `#/document/${encodeURIComponent(doc.id)}`;
    if (window.location.hash === targetHash) {
        state.route = { view: "detail", id: doc.id };
        renderRoute();
    } else {
        window.location.hash = targetHash;
    }
}

function updateBreadcrumb(doc) {
    if (!elements.breadcrumb) {
        return;
    }

    const list = document.createElement("ol");
    const homeItem = document.createElement("li");

    if (doc) {
        const homeLink = document.createElement("a");
        homeLink.href = "#/";
        homeLink.textContent = "Home";
        homeLink.className = "crumb-link";
        homeLink.addEventListener("click", (event) => {
            event.preventDefault();
            navigateToIndex();
        });
        homeItem.appendChild(homeLink);
    } else {
        homeItem.textContent = "Home";
        homeItem.setAttribute("aria-current", "page");
    }

    list.appendChild(homeItem);

    if (doc) {
        const docItem = document.createElement("li");
        docItem.textContent = doc.documentNumber;
        docItem.setAttribute("aria-current", "page");
        list.appendChild(docItem);
    }

    elements.breadcrumb.innerHTML = "";
    elements.breadcrumb.appendChild(list);
}

function createSlug(value = "") {
    return value
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "resource";
}

function createBadge(label = "") {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = label;
    return badge;
}

function appendMeta(container, label, value) {
    if (!value) {
        return;
    }

    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    container.append(dt, dd);
}

function appendMetaText(container, label, value) {
    if (!value) {
        return;
    }

    const span = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    span.append(strong, value);
    container.appendChild(span);
}

function compareStrings(a = "", b = "") {
    return a.localeCompare(b, undefined, { sensitivity: "base" });
}

function parseDate(value = "") {
    const cleaned = value.replace(/-/g, " ").trim();
    const date = new Date(cleaned || value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function stripHtml(html = "") {
    const temp = document.createElement("div");
    temp.innerHTML = html;
    return temp.textContent || temp.innerText || "";
}

function escapeHtml(value = "") {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

