document.addEventListener('DOMContentLoaded', () => {
    // Dom Elements
    const newsContainer = document.getElementById('news-container');
    const loadingContainer = document.getElementById('loading-container');
    const emptyState = document.getElementById('empty-state');
    const refreshBtn = document.getElementById('refresh-btn');
    const retryBtn = document.getElementById('retry-btn');
    // langToggle removed
    const lastUpdated = document.getElementById('last-updated');

    // Modal DOM Elements
    const articleModal = document.getElementById('article-modal');
    const modalClose = document.getElementById('modal-close');
    const modalTitle = document.getElementById('modal-title');
    const modalContent = document.getElementById('modal-content');
    const modalSource = document.getElementById('modal-source');
    const modalDate = document.getElementById('modal-date');
    const modalImage = document.getElementById('modal-image');
    const modalImageContainer = document.getElementById('modal-image-container');
    // modalOriginalLink removed

    let posts = [];
    let isMizo = true; // Default to Mizo language

    // Fetch news from the API
    async function fetchNews(forceRefresh = false) {
        showLoading(true);
        try {
            const endpoint = forceRefresh ? '/api/refresh' : '/api/news';
            const response = await fetch(endpoint);
            
            if (!response.ok) {
                throw new Error('Failed to fetch news from server');
            }
            
            const data = await response.json();
            
            // Handle if server returns { success: true, posts: [...] } for refresh endpoint
            posts = Array.isArray(data) ? data : (data.posts || []);
            
            renderNews();
            updateLastUpdated();
        } catch (error) {
            console.error('Error fetching news:', error);
            showErrorState();
        }
    }

    // Render news cards to the container
    function renderNews() {
        showLoading(false);
        
        if (posts.length === 0) {
            emptyState.classList.remove('hidden');
            newsContainer.classList.add('hidden');
            return;
        }

        emptyState.classList.add('hidden');
        newsContainer.classList.remove('hidden');
        newsContainer.innerHTML = '';

        posts.forEach((post, index) => {
            const card = document.createElement('div');
            card.className = 'card card-clickable';
            card.setAttribute('data-index', index);
            
            // Set titles and summaries depending on language toggle
            const displayTitle = isMizo ? (post.mizoTitle || post.title) : post.title;
            const displaySummary = isMizo ? (post.mizoSummary || post.description) : post.description;
            
            // Format publication date
            const formattedDate = formatDate(post.pubDate);
            
            // Media container (image or beautiful fallback)
            let mediaHTML = '';
            if (post.image) {
                mediaHTML = `
                    <div class="card-media">
                        <span class="card-badge">${post.source}</span>
                        <img src="${post.image}" alt="News Image" class="card-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                        <div class="card-placeholder" style="display:none;">
                            <i class="fa-solid fa-fire-flame-curved placeholder-logo"></i>
                            <span class="placeholder-text">United News</span>
                        </div>
                    </div>
                `;
            } else {
                mediaHTML = `
                    <div class="card-media">
                        <span class="card-badge">${post.source}</span>
                        <div class="card-placeholder">
                            <i class="fa-solid fa-fire-flame-curved placeholder-logo"></i>
                            <span class="placeholder-text">United News</span>
                        </div>
                    </div>
                `;
            }

            card.innerHTML = `
                ${mediaHTML}
                <div class="card-content">
                    <div class="card-meta">
                        <span class="card-source"><i class="fa-solid fa-newspaper"></i> ${post.source}</span>
                        <span><i class="fa-regular fa-clock"></i> ${formattedDate}</span>
                    </div>
                    <h2 class="card-title">${displayTitle}</h2>
                    <p class="card-summary">${displaySummary}</p>
                    <div class="card-footer">
                        <button class="card-link-btn read-more-btn" data-index="${index}">
                            Chhiar Zau Rawh <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>
            `;
            
            newsContainer.appendChild(card);
        });
    }

    // Toggle loading skeletons
    function showLoading(loading) {
        if (loading) {
            loadingContainer.classList.remove('hidden');
            newsContainer.classList.add('hidden');
            emptyState.classList.add('hidden');
            refreshBtn.disabled = true;
            refreshBtn.querySelector('i').classList.add('fa-spin');
        } else {
            loadingContainer.classList.add('hidden');
            refreshBtn.disabled = false;
            refreshBtn.querySelector('i').classList.remove('fa-spin');
        }
    }

    // Show error / empty state
    function showErrorState() {
        showLoading(false);
        emptyState.classList.remove('hidden');
        newsContainer.classList.add('hidden');
    }

    // Helper: format publication date
    function formatDate(dateStr) {
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const diffMs = now - date;
            const diffMins = Math.floor(diffMs / (1000 * 60));
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            
            if (diffMins < 60) {
                return `Minute ${diffMins} kalta`;
            } else if (diffHours < 24) {
                return `Darkar ${diffHours} kalta`;
            } else {
                return date.toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric'
                });
            }
        } catch (e) {
            return dateStr;
        }
    }

    // Helper: Format text to HTML paragraphs
    function formatParagraphs(text) {
        if (!text) return '';
        // Split by single or double newlines and wrap in <p> tags
        return text.split(/\n+/).map(p => {
            const trimmed = p.trim();
            return trimmed ? `<p>${trimmed}</p>` : '';
        }).join('');
    }

    // Modal display logic
    function openArticleModal(index) {
        const post = posts[index];
        if (!post) return;

        const titleText = isMizo ? (post.mizoTitle || post.title) : post.title;
        // Detailed report for Mizo, or original English summary for English view
        const bodyText = isMizo ? (post.mizoFullReport || post.mizoSummary || post.description) : post.description;

        modalTitle.innerText = titleText;
        modalContent.innerHTML = formatParagraphs(bodyText);
        modalSource.innerText = post.source;
        modalDate.innerHTML = `<i class="fa-regular fa-clock"></i> ${formatDate(post.pubDate)}`;
        // modalOriginalLink.href removed

        if (post.image) {
            modalImage.src = post.image;
            modalImageContainer.style.display = 'block';
        } else {
            modalImageContainer.style.display = 'none';
        }

        articleModal.classList.remove('hidden');
        document.documentElement.classList.add('modal-open');
        document.body.classList.add('modal-open');
    }

    function closeArticleModal() {
        articleModal.classList.add('hidden');
        document.documentElement.classList.remove('modal-open');
        document.body.classList.remove('modal-open');
    }

    // Update last updated status bar
    function updateLastUpdated() {
        const now = new Date();
        lastUpdated.innerHTML = `<i class="fa-regular fa-calendar-check"></i> Updated: ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    // Event Listeners
    refreshBtn.addEventListener('click', () => fetchNews(true));
    retryBtn.addEventListener('click', () => fetchNews(true));
    
    // langToggle listener removed

    // Modal Close Listeners
    modalClose.addEventListener('click', closeArticleModal);
    
    // Close when clicking overlay backdrop
    articleModal.addEventListener('click', (e) => {
        if (e.target === articleModal) {
            closeArticleModal();
        }
    });

    // Close when pressing Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!articleModal.classList.contains('hidden')) closeArticleModal();
            if (!privacyModal.classList.contains('hidden')) closePrivacyModal();
        }
    });

    // Privacy Modal Elements and Event Listeners
    const privacyModal = document.getElementById('privacy-modal');
    const privacyBtn = document.getElementById('privacy-btn');
    const privacyClose = document.getElementById('privacy-close');

    function openPrivacyModal() {
        privacyModal.classList.remove('hidden');
        document.documentElement.classList.add('modal-open');
        document.body.classList.add('modal-open');
    }

    function closePrivacyModal() {
        privacyModal.classList.add('hidden');
        document.documentElement.classList.remove('modal-open');
        document.body.classList.remove('modal-open');
    }

    if (privacyBtn) {
        privacyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openPrivacyModal();
        });
    }

    if (privacyClose) {
        privacyClose.addEventListener('click', closePrivacyModal);
    }

    privacyModal.addEventListener('click', (e) => {
        if (e.target === privacyModal) {
            closePrivacyModal();
        }
    });

    // Delegate clicks on clickable cards
    newsContainer.addEventListener('click', (e) => {
        const card = e.target.closest('.card-clickable');
        if (card) {
            const index = card.getAttribute('data-index');
            openArticleModal(index);
        }
    });

    // Initial load
    fetchNews();
});
