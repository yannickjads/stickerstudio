Pod::Spec.new do |s|
  s.name           = 'SubjectCutout'
  s.version        = '1.0.0'
  s.summary        = 'Lift the subject off its background'
  s.description    = 'Uses on-device subject lifting from the Vision framework to cut a subject out of its background.'
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
