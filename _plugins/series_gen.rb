module Jekyll
  class SeriesPageGenerator < Generator
    safe true

    def generate(site)
      series_data = site.data['series']
      series_data.each do |series|
        site.pages << SeriesPage.new(site, site.source, "series", series)
      end
    end
  end

  class SeriesPage < Page
    def initialize(site, base, dir, series)
      @site = site
      @base = base
      @dir = dir
      @name = "#{series['name'].gsub(/\s+/, '-').downcase}.html"

      self.process(@name)
      self.read_yaml(File.join(base, '_layouts'), 'series_detail.html')
      self.data['series'] = series
      self.data['title'] = series['name']
    end
  end
end
