package com.alleluia.aria;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

public class MainActivity extends Activity {
  private WebView web;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);

    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setMediaPlaybackRequiresUserGesture(false);
    web.setBackgroundColor(0xFFFBFBFA);

    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        String host = req.getUrl().getHost();
        if (host == null || !host.equals("aria.local")) return null;
        String path = req.getUrl().getPath();
        if (path == null || path.equals("") || path.equals("/")) path = "/index.html";
        try {
          InputStream in = getAssets().open("web" + path);
          return new WebResourceResponse(mime(path), "utf-8", in);
        } catch (IOException e) {
          return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        }
      }
    });

    setContentView(web);
    web.loadUrl("https://aria.local/index.html");
  }

  private static String mime(String p) {
    if (p.endsWith(".css")) return "text/css";
    if (p.endsWith(".js")) return "application/javascript";
    if (p.endsWith(".html")) return "text/html";
    if (p.endsWith(".svg")) return "image/svg+xml";
    if (p.endsWith(".png")) return "image/png";
    return "application/octet-stream";
  }

  @Override
  public void onBackPressed() {
    if (web != null && web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }
}
