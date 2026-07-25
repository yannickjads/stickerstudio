Pod::Spec.new do |s|
  s.name           = 'NativePrompt'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS alert with text fields'
  s.description    = 'Presents a UIAlertController with text fields so dialogs look and animate like the system.'
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
