Pod::Spec.new do |s|
  s.name           = 'WhatsAppStickers'
  s.version        = '1.0.0'
  s.summary        = 'Send sticker packs to WhatsApp'
  s.description    = 'Exports sticker packs to WhatsApp via its third-party pasteboard interop.'
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
