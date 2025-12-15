---
layout: page
title: About me
permalink: /aboutme.html
redirect: true
---

<script>
  // Redirect to the correct language version based on preference
  (function() {
    var preferredLang = localStorage.getItem('siteLanguage') || 'vi';
    var baseUrl = window.location.origin + (window.location.pathname.includes('/minhmannh2001.github.io') ? '/minhmannh2001.github.io' : '');
    var targetUrl = baseUrl + (preferredLang === 'en' ? '/aboutme-en.html' : '/aboutme-vi.html');
    window.location.href = targetUrl;
  })();
</script>

<p>Redirecting...</p>

