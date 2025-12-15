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
    
    // Filter posts based on language
    var filterPosts = function(lang) {
      var posts = document.querySelectorAll('.post-preview');
      var visibleCount = 0;
      
      posts.forEach(function(post) {
        var postLang = post.getAttribute('data-post-lang');
        if (postLang === lang || !postLang) {
          post.style.display = '';
          visibleCount++;
        } else {
          post.style.display = 'none';
        }
      });
      
      // Show message if no posts found
      var postsList = document.querySelector('.posts-list');
      var noPostsMsg = document.getElementById('no-posts-message');
      if (visibleCount === 0 && posts.length > 0) {
        if (!noPostsMsg) {
          noPostsMsg = document.createElement('div');
          noPostsMsg.id = 'no-posts-message';
          noPostsMsg.className = 'no-posts-message';
          noPostsMsg.textContent = 'No posts found for the selected language.';
          postsList.appendChild(noPostsMsg);
        }
        noPostsMsg.style.display = 'block';
      } else if (noPostsMsg) {
        noPostsMsg.style.display = 'none';
      }
    };
    
    // Update language switcher display and highlight current language
    var updateLanguageSwitcher = function(lang) {
      $('.language-switcher-link').each(function() {
        var $current = $(this).find('.current-lang');
        var $other = $(this).find('.other-lang');
        var $link = $(this);
        
        // Remove previous highlighting
        $current.removeClass('active');
        $other.removeClass('active');
        
        if (lang === 'en') {
          $current.text('EN');
          $other.text('VI');
          $current.addClass('active');
        } else {
          $current.text('VI');
          $other.text('EN');
          $current.addClass('active');
        }
        $link.attr('data-current-lang', lang);
      });
    };
    
    // Detect current page language from URL
    var detectPageLanguage = function() {
      var currentPath = window.location.pathname;
      var pageMatch = currentPath.match(/(aboutme|openlearning)-(\w+)\.html$/);
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
    
    // Handle language selector clicks
    $(document).on('click', '.language-switcher-link[data-lang-selector="true"]', function(e) {
      e.preventDefault();
      var currentLang = $(this).attr('data-current-lang') || getLanguagePreference();
      var newLang = currentLang === 'en' ? 'vi' : 'en';
      
      // Update preference
      setLanguagePreference(newLang);
      
      // Filter posts on home page
      filterPosts(newLang);
      
      // Update all language switchers
      updateLanguageSwitcher(newLang);
      
      // Handle page redirects for aboutme and openlearning
      var currentPath = window.location.pathname;
      if (currentPath.includes('/aboutme') || currentPath.includes('/openlearning')) {
        var pageMatch = currentPath.match(/(aboutme|openlearning)(?:-(\w+))?\.html$/);
        if (pageMatch) {
          var pageName = pageMatch[1];
          var newPath = '/' + pageName + '-' + newLang + '.html';
          window.location.href = newPath;
          return;
        }
      }
    });
    
    // Handle language switch links (for posts/pages with both versions)
    $(document).on('click', '.language-switcher-link[data-lang-switch="true"]', function(e) {
      // Let the link work normally, but also update preference
      var href = $(this).attr('href');
      var targetLang = (href.includes('-en.html') || href.includes('-en/')) ? 'en' : 'vi';
      setLanguagePreference(targetLang);
      // Link will navigate, so preference is saved for next page
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
    
    // Apply language filter on home page
    filterPosts(preferredLang);
  }
};

// 2fc73a3a967e97599c9763d05e564189

document.addEventListener('DOMContentLoaded', function() {
  main.init();
  main.initLanguageFilter();
});
