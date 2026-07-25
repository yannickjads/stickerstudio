Pod::Spec.new do |s|
  s.name           = 'VideoFrames'
  s.version        = '1.0.0'
  s.summary        = 'Extract frames from a video'
  s.description    = 'Extracts evenly spaced, downscaled frames from a video with AVFoundation.'
  s.author         = 'Sticker Studio'
  s.homepage       = 'https://expo.dev'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,swift}'
end
