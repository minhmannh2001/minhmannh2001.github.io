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
    var filterPosts = function(lang, isInitialLoad) {
      var posts = document.querySelectorAll('.post-preview');
      var visibleCount = 0;
      var hiddenCount = 0;
      var hasMultipleLanguages = false;
      
      // Check if there are posts in multiple languages on this page
      var languagesFound = new Set();
      posts.forEach(function(post) {
        var postLang = post.getAttribute('data-post-lang') || 'vi';
        languagesFound.add(postLang);
      });
      hasMultipleLanguages = languagesFound.size > 1;
      
      // Always filter based on language preference
      // Show/hide posts based on language
      posts.forEach(function(post) {
        var postLang = post.getAttribute('data-post-lang');
        if (postLang === lang || !postLang) {
          post.style.display = '';
          visibleCount++;
        } else {
          post.style.display = 'none';
          hiddenCount++;
        }
      });
      
      // Handle pagination - check if there are more posts in selected language
      var pager = document.getElementById('post-pager');
      if (pager) {
        if (hiddenCount > 0) {
          // We're filtering - temporarily hide pagination while checking
          pager.style.display = 'none';
          
          // Check if there are more posts in selected language on next/previous pages
          checkPaginationForLanguage(lang, function(hasMorePosts, hasPreviousPosts) {
            if (pager) {
              var nextLink = pager.querySelector('.next');
              var prevLink = pager.querySelector('.previous');
              
              // Show pagination container if either button should be visible
              if (hasMorePosts || hasPreviousPosts) {
                pager.style.display = '';
                
                // Show/hide individual buttons
                if (nextLink) {
                  nextLink.style.display = hasMorePosts ? '' : 'none';
                }
                if (prevLink) {
                  prevLink.style.display = hasPreviousPosts ? '' : 'none';
                }
              } else {
                pager.style.display = 'none';
              }
            }
          });
        } else {
          // No filtering (all posts visible) - show pagination as normal
          pager.style.display = '';
        }
      }
      
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
    
    // Check if there are more posts in the selected language on next/previous pages
    var checkPaginationForLanguage = function(lang, callback) {
      var pager = document.getElementById('post-pager');
      if (!pager) {
        callback(false, false);
        return;
      }
      
      var nextPageLink = pager.querySelector('.next a');
      var prevPageLink = pager.querySelector('.previous a');
      
      var hasMorePosts = false;
      var hasPreviousPosts = false;
      var checksCompleted = 0;
      var totalChecks = (nextPageLink ? 1 : 0) + (prevPageLink ? 1 : 0);
      
      if (totalChecks === 0) {
        callback(false, false);
        return;
      }
      
      var checkComplete = function() {
        checksCompleted++;
        if (checksCompleted === totalChecks) {
          callback(hasMorePosts, hasPreviousPosts);
        }
      };
      
      // Check next page
      if (nextPageLink) {
        var nextPageUrl = nextPageLink.getAttribute('href');
        if (nextPageUrl) {
          // Make absolute URL if needed
          if (nextPageUrl.startsWith('/')) {
            nextPageUrl = window.location.origin + nextPageUrl;
          } else if (!nextPageUrl.startsWith('http')) {
            nextPageUrl = window.location.origin + '/' + nextPageUrl;
          }
          
          fetch(nextPageUrl)
            .then(function(response) {
              return response.text();
            })
            .then(function(html) {
              // Parse the HTML to count posts in the selected language
              var parser = new DOMParser();
              var doc = parser.parseFromString(html, 'text/html');
              var nextPagePosts = doc.querySelectorAll('.post-preview[data-post-lang="' + lang + '"]');
              
              // Also count posts without data-post-lang (default to 'vi')
              var postsWithoutLang = doc.querySelectorAll('.post-preview:not([data-post-lang])');
              var count = nextPagePosts.length;
              if (lang === 'vi') {
                count += postsWithoutLang.length;
              }
              
              hasMorePosts = count > 0;
              checkComplete();
            })
            .catch(function(error) {
              console.error('Error checking next page:', error);
              checkComplete();
            });
        } else {
          checkComplete();
        }
      }
      
      // Check previous page
      if (prevPageLink) {
        var prevPageUrl = prevPageLink.getAttribute('href');
        if (prevPageUrl) {
          // Make absolute URL if needed
          if (prevPageUrl.startsWith('/')) {
            prevPageUrl = window.location.origin + prevPageUrl;
          } else if (!prevPageUrl.startsWith('http')) {
            prevPageUrl = window.location.origin + '/' + prevPageUrl;
          }
          
          fetch(prevPageUrl)
            .then(function(response) {
              return response.text();
            })
            .then(function(html) {
              // Parse the HTML to count posts in the selected language
              var parser = new DOMParser();
              var doc = parser.parseFromString(html, 'text/html');
              var prevPagePosts = doc.querySelectorAll('.post-preview[data-post-lang="' + lang + '"]');
              
              // Also count posts without data-post-lang (default to 'vi')
              var postsWithoutLang = doc.querySelectorAll('.post-preview:not([data-post-lang])');
              var count = prevPagePosts.length;
              if (lang === 'vi') {
                count += postsWithoutLang.length;
              }
              
              hasPreviousPosts = count > 0;
              checkComplete();
            })
            .catch(function(error) {
              console.error('Error checking previous page:', error);
              checkComplete();
            });
        } else {
          checkComplete();
        }
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
      filterPosts(newLang, false);
      
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
    filterPosts(preferredLang, true);
  }
};

// 2fc73a3a967e97599c9763d05e564189

document.addEventListener('DOMContentLoaded', function() {
  main.init();
  main.initLanguageFilter();
});
