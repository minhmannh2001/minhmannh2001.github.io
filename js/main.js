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
    
    // Handle language selector clicks
    $(document).on('click', '.language-switcher-link[data-lang-selector="true"]', function(e) {
      e.preventDefault();
      var currentLang = $(this).attr('data-current-lang') || 'vi';
      var newLang = currentLang === 'en' ? 'vi' : 'en';
      
      // Update preference
      setLanguagePreference(newLang);
      
      // Filter posts
      filterPosts(newLang);
      
      // Update all language switchers on the page
      $('.language-switcher-link[data-lang-selector="true"]').each(function() {
        var $current = $(this).find('.current-lang');
        var $other = $(this).find('.other-lang');
        if (newLang === 'en') {
          $current.text('EN');
          $other.text('VI');
        } else {
          $current.text('VI');
          $other.text('EN');
        }
        $(this).attr('data-current-lang', newLang);
      });
    });
    
    // Apply language filter on page load
    var preferredLang = getLanguagePreference();
    filterPosts(preferredLang);
    
    // Update language switcher display based on preference
    $('.language-switcher-link[data-lang-selector="true"]').each(function() {
      var $current = $(this).find('.current-lang');
      var $other = $(this).find('.other-lang');
      if (preferredLang === 'en') {
        $current.text('EN');
        $other.text('VI');
      } else {
        $current.text('VI');
        $other.text('EN');
      }
      $(this).attr('data-current-lang', preferredLang);
    });
    
    // Handle page language switching - redirect to correct version if needed
    var handlePageLanguage = function() {
      var currentPath = window.location.pathname;
      var preferredLang = getLanguagePreference();
      
      // Check if we're on a page with language suffix
      var pageMatch = currentPath.match(/(aboutme|openlearning)-(\w+)\.html$/);
      if (pageMatch) {
        var pageName = pageMatch[1];
        var currentPageLang = pageMatch[2];
        
        // If current page language doesn't match preference, redirect
        if (currentPageLang !== preferredLang) {
          var newPath = currentPath.replace('-' + currentPageLang + '.html', '-' + preferredLang + '.html');
          // Check if the other language version exists before redirecting
          // We'll let the user manually switch to avoid redirect loops
        }
      } else {
        // If on a page without language suffix, check if we should redirect
        // This handles cases where user navigates to base page
        if (currentPath.includes('/aboutme') || currentPath.includes('/openlearning')) {
          // Try to find the preferred language version
          var basePath = currentPath.replace(/\.html$/, '');
          var preferredPath = basePath + '-' + preferredLang + '.html';
          // Don't auto-redirect, let user choose
        }
      }
    };
    
    // Only run on pages (not posts or index)
    if (document.querySelector('.page-content') || document.body.classList.contains('page')) {
      // Don't auto-redirect, just update the switcher
    }
  }
};

// 2fc73a3a967e97599c9763d05e564189

document.addEventListener('DOMContentLoaded', function() {
  main.init();
  main.initLanguageFilter();
});
