// Dean Attali / Beautiful Jekyll 2016

var main = {

  bigImgEl : null,
  numImgs : null,

  init : function() {
    // Shorten the navbar after scrolling a little bit down
    $(window).scroll(function() {
        if ($(".navbar").offset().top > 50) {
            $(".navbar").addClass("top-nav-short");
        } else {
            $(".navbar").removeClass("top-nav-short");
        }
    });
    
    // On mobile, hide the avatar when expanding the navbar menu
    $('#main-navbar').on('show.bs.collapse', function () {
      $(".navbar").addClass("top-nav-expanded");
    });
    $('#main-navbar').on('hidden.bs.collapse', function () {
      $(".navbar").removeClass("top-nav-expanded");
    });
	
    // On mobile, when clicking on a multi-level navbar menu, show the child links
    $('#main-navbar').on("click", ".navlinks-parent", function(e) {
      var target = e.target;
      $.each($(".navlinks-parent"), function(key, value) {
        if (value == target) {
          $(value).parent().toggleClass("show-children");
        } else {
          $(value).parent().removeClass("show-children");
        }
      });
    });
    
    // Ensure nested navbar menus are not longer than the menu header
    var menus = $(".navlinks-container");
    if (menus.length > 0) {
      var navbar = $("#main-navbar ul");
      var fakeMenuHtml = "<li class='fake-menu' style='display:none;'><a></a></li>";
      navbar.append(fakeMenuHtml);
      var fakeMenu = $(".fake-menu");

      $.each(menus, function(i) {
        var parent = $(menus[i]).find(".navlinks-parent");
        var children = $(menus[i]).find(".navlinks-children a");
        var words = [];
        $.each(children, function(idx, el) { words = words.concat($(el).text().trim().split(/\s+/)); });
        var maxwidth = 0;
        $.each(words, function(id, word) {
          fakeMenu.html("<a>" + word + "</a>");
          var width =  fakeMenu.width();
          if (width > maxwidth) {
            maxwidth = width;
          }
        });
        $(menus[i]).css('min-width', maxwidth + 'px')
      });

      fakeMenu.remove();
    }        
    
    // show the big header image	
    main.initImgs();
  },
  
  initImgs : function() {
    // If the page was large images to randomly select from, choose an image
    if ($("#header-big-imgs").length > 0) {
      main.bigImgEl = $("#header-big-imgs");
      main.numImgs = main.bigImgEl.attr("data-num-img");

          // 2fc73a3a967e97599c9763d05e564189
	  // set an initial image
	  var imgInfo = main.getImgInfo();
	  var src = imgInfo.src;
	  var desc = imgInfo.desc;
  	  main.setImg(src, desc);
  	
	  // For better UX, prefetch the next image so that it will already be loaded when we want to show it
  	  var getNextImg = function() {
	    var imgInfo = main.getImgInfo();
	    var src = imgInfo.src;
	    var desc = imgInfo.desc;		  
	    
		var prefetchImg = new Image();
  		prefetchImg.src = src;
		// if I want to do something once the image is ready: `prefetchImg.onload = function(){}`
		
  		setTimeout(function(){
                  var img = $("<div></div>").addClass("big-img-transition").css("background-image", 'url(' + src + ')');
  		  $(".intro-header.big-img").prepend(img);
  		  setTimeout(function(){ img.css("opacity", "1"); }, 50);
		  
		  // after the animation of fading in the new image is done, prefetch the next one
  		  //img.one("transitioned webkitTransitionEnd oTransitionEnd MSTransitionEnd", function(){
		  setTimeout(function() {
		    main.setImg(src, desc);
			img.remove();
  			getNextImg();
		  }, 1000); 
  		  //});		
  		}, 6000);
  	  };
	  
	  // If there are multiple images, cycle through them
	  if (main.numImgs > 1) {
  	    getNextImg();
	  }
    }
  },
  
  getImgInfo : function() {
  	var randNum = Math.floor((Math.random() * main.numImgs) + 1);
    var src = main.bigImgEl.attr("data-img-src-" + randNum);
	var desc = main.bigImgEl.attr("data-img-desc-" + randNum);
	
	return {
	  src : src,
	  desc : desc
	}
  },
  
  setImg : function(src, desc) {
	$(".intro-header.big-img").css("background-image", 'url(' + src + ')');
	if (typeof desc !== typeof undefined && desc !== false) {
	  $(".img-desc").text(desc).show();
	} else {
	  $(".img-desc").hide();  
	}
  },
  
  // Language filtering functionality
  initLanguageFilter : function() {
    // Get language preference from localStorage or default to 'vi'
    var getLanguagePreference = function() {
      var stored = localStorage.getItem('siteLanguage');
      return stored || 'vi';
    };

    // Set language preference
    var setLanguagePreference = function(lang) {
      localStorage.setItem('siteLanguage', lang);
    };

    // Virtual pagination
    var vp = {
      postsPerPage: 10,
      page: 1,
      lang: 'vi',

      allPosts: function() {
        return Array.from(document.querySelectorAll('.post-preview'));
      },

      postsForLang: function(lang) {
        return this.allPosts().filter(function(p) {
          return (p.getAttribute('data-post-lang') || 'vi') === lang;
        });
      },

      showPage: function(lang, page) {
        this.lang = lang;
        this.page = page;
        var langPosts = this.postsForLang(lang);
        var start = (page - 1) * this.postsPerPage;
        var visible = new Set(langPosts.slice(start, start + this.postsPerPage));
        this.allPosts().forEach(function(p) {
          p.style.display = visible.has(p) ? '' : 'none';
        });
        this.renderPager(langPosts.length);
        var noMsg = document.getElementById('no-posts-message');
        if (langPosts.length === 0) {
          if (!noMsg) {
            noMsg = document.createElement('div');
            noMsg.id = 'no-posts-message';
            noMsg.className = 'no-posts-message';
            noMsg.textContent = 'No posts found for the selected language.';
            var list = document.querySelector('.posts-list');
            if (list) list.appendChild(noMsg);
          }
          noMsg.style.display = 'block';
        } else if (noMsg) {
          noMsg.style.display = 'none';
        }
      },

      renderPager: function(total) {
        var pager = document.getElementById('post-pager');
        if (!pager) return;
        var totalPages = Math.ceil(total / this.postsPerPage);
        if (totalPages <= 1) { pager.style.display = 'none'; return; }
        pager.style.display = '';
        var prevEl = pager.querySelector('.previous');
        var nextEl = pager.querySelector('.next');
        if (prevEl) prevEl.style.display = this.page > 1 ? '' : 'none';
        if (nextEl) nextEl.style.display = this.page < totalPages ? '' : 'none';
      }
    };

    // Update language switcher: mark the active option in the dropdown
    var updateLanguageSwitcher = function(lang) {
      $('.lang-option').each(function() {
        var optLang = $(this).attr('data-lang');
        if (optLang === lang) {
          $(this).addClass('lang-option-active');
          $(this).find('.lang-check').text('✓');
        } else {
          $(this).removeClass('lang-option-active');
          $(this).find('.lang-check').text('');
        }
      });
      $('.lang-dropdown[data-mode="selector"]').attr('data-current-lang', lang);
    };

    // Detect current page language from URL
    var detectPageLanguage = function() {
      var currentPath = window.location.pathname;
      var pageMatch = currentPath.match(/(aboutme|openlearning|series|timeline)-(\w+)\.html$/);
      if (pageMatch) {
        return pageMatch[2]; // 'en' or 'vi'
      }
      // Check for post URLs
      var postMatch = currentPath.match(/-(\w+)\.html$/);
      if (postMatch && (postMatch[1] === 'en' || postMatch[1] === 'vi')) {
        return postMatch[1];
      }
      return null;
    };

    // Series detail page: filter list by language, renumber visible rows, toggle empty message
    var filterSeriesDetailPosts = function(lang) {
      var root = document.querySelector('.series-detail[data-series-detail="true"]');
      if (!root) {
        return;
      }
      var items = root.querySelectorAll('.series-post-item[data-post-lang]');
      if (!items.length) {
        return;
      }
      var hasEn = false;
      var hasVi = false;
      for (var i = 0; i < items.length; i++) {
        var pl = items[i].getAttribute('data-post-lang');
        if (pl === 'en') {
          hasEn = true;
        }
        if (pl === 'vi') {
          hasVi = true;
        }
      }
      root.setAttribute('data-series-has-en', hasEn ? 'true' : 'false');
      root.setAttribute('data-series-has-vi', hasVi ? 'true' : 'false');
      var visible = 0;
      for (var j = 0; j < items.length; j++) {
        var show = items[j].getAttribute('data-post-lang') === lang;
        items[j].style.display = show ? '' : 'none';
        if (show) {
          visible++;
        }
      }
      var emptyEl = document.getElementById('series-detail-no-posts');
      if (emptyEl) {
        emptyEl.style.display = visible === 0 ? 'block' : 'none';
      }
      var n = 0;
      for (var k = 0; k < items.length; k++) {
        if (items[k].style.display !== 'none') {
          n++;
          var badge = items[k].querySelector('.post-number');
          if (badge) {
            badge.textContent = n;
          }
        }
      }
    };

    // Toggle the language dropdown open/closed
    $(document).on('click', '.lang-dropdown-btn', function(e) {
      e.stopPropagation();
      var $menu = $(this).siblings('.lang-dropdown-menu');
      var isOpen = $menu.hasClass('open');
      // Close any other open dropdowns
      $('.lang-dropdown-menu.open').removeClass('open');
      $('.lang-dropdown-btn').attr('aria-expanded', 'false');
      if (!isOpen) {
        $menu.addClass('open');
        $(this).attr('aria-expanded', 'true');
      }
    });

    // Close dropdown when clicking outside
    $(document).on('click', function(e) {
      if (!$(e.target).closest('.lang-dropdown').length) {
        $('.lang-dropdown-menu.open').removeClass('open');
        $('.lang-dropdown-btn').attr('aria-expanded', 'false');
      }
    });

    // Pager navigation
    $(document).on('click', '#post-pager .previous a', function(e) {
      e.preventDefault();
      if (vp.page > 1) { vp.showPage(vp.lang, vp.page - 1); window.scrollTo(0, 0); }
    });
    $(document).on('click', '#post-pager .next a', function(e) {
      e.preventDefault();
      var total = vp.postsForLang(vp.lang).length;
      if (vp.page < Math.ceil(total / vp.postsPerPage)) {
        vp.showPage(vp.lang, vp.page + 1);
        window.scrollTo(0, 0);
      }
    });

    // Handle clicks on language options
    $(document).on('click', '.lang-dropdown .lang-option', function(e) {
      e.preventDefault();
      var $option = $(this);
      var newLang = $option.attr('data-lang');
      var $dropdown = $option.closest('.lang-dropdown');
      var mode = $dropdown.attr('data-mode');

      // Close the dropdown
      $dropdown.find('.lang-dropdown-menu').removeClass('open');
      $dropdown.find('.lang-dropdown-btn').attr('aria-expanded', 'false');

      // Already on this language — nothing to do
      if ($option.hasClass('lang-option-active')) {
        return;
      }

      if (mode === 'direct') {
        // Navigate to the other language version
        var href = $option.attr('href');
        setLanguagePreference(newLang);
        window.location.href = href;
        return;
      }

      // Selector mode: filter/redirect without full page navigation
      var seriesRoot = document.querySelector('.series-detail[data-series-detail="true"]');
      if (seriesRoot) {
        var targetAvailable = newLang === 'en'
          ? seriesRoot.getAttribute('data-series-has-en') === 'true'
          : seriesRoot.getAttribute('data-series-has-vi') === 'true';
        if (!targetAvailable) {
          var $modal = $('#series-lang-unavailable-modal');
          if ($modal.length) {
            $('#series-lang-unavailable-msg-en').toggle(newLang === 'en');
            $('#series-lang-unavailable-msg-vi').toggle(newLang === 'vi');
            $modal.modal('show');
          } else {
            var msg = newLang === 'en'
              ? 'This series does not include any posts in English.'
              : 'Series này không có bài viết tiếng Việt.';
            window.alert(msg);
          }
          return;
        }
      }

      setLanguagePreference(newLang);
      vp.showPage(newLang, 1);
      filterSeriesDetailPosts(newLang);
      updateLanguageSwitcher(newLang);
      if (typeof updateLanguageFilterInfo === 'function') { updateLanguageFilterInfo(); }

      var currentPath = window.location.pathname;
      if (currentPath.includes('/aboutme') || currentPath.includes('/openlearning')) {
        var pageMatch = currentPath.match(/(aboutme|openlearning)(?:-(\w+))?\.html$/);
        if (pageMatch) {
          var pageName = pageMatch[1];
          window.location.href = '/' + pageName + '-' + newLang + '.html';
          return;
        }
      }
      if (currentPath.match(/^\/series(-(vi|en))?\.html$/) || currentPath === '/series/' || currentPath === '/series') {
        window.location.href = '/series-' + newLang + '.html';
        return;
      }
      if (currentPath.match(/^\/timeline(-(vi|en))?\.html$/) || currentPath === '/timeline/' || currentPath === '/timeline') {
        window.location.href = '/timeline-' + newLang + '.html';
        return;
      }
    });

    // Detect current page language and update preference
    var detectedLang = detectPageLanguage();
    var preferredLang = getLanguagePreference();

    if (detectedLang) {
      // If we're on a language-specific page, use that language
      setLanguagePreference(detectedLang);
      updateLanguageSwitcher(detectedLang);
      preferredLang = detectedLang;
    } else {
      // Use stored preference or default
      updateLanguageSwitcher(preferredLang);
    }

    // Apply virtual pagination on home page
    vp.showPage(preferredLang, 1);

    // Series detail: align list with preference (refine after inline script)
    filterSeriesDetailPosts(preferredLang);
  }
};

// 2fc73a3a967e97599c9763d05e564189

document.addEventListener('DOMContentLoaded', function() {
  main.init();
  main.initLanguageFilter();
});
