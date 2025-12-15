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
    var targetUrl = preferredLang === 'en' ? '/aboutme-en.html' : '/aboutme-vi.html';
    window.location.href = targetUrl;
  })();
</script>

<p>Redirecting...</p>

