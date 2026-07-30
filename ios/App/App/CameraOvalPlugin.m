#import <Capacitor/Capacitor.h>

CAP_PLUGIN(CameraOvalPlugin, "CameraOval",
    CAP_PLUGIN_METHOD(startEmbedded, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(updateEmbeddedRect, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(capture, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopEmbedded, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(open, CAPPluginReturnPromise);
)
