import AppKit
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let logoURL = root.appendingPathComponent("src-tauri/icons/icon.png")
guard let logo = NSImage(contentsOf: logoURL) else {
    fatalError("Unable to load app icon at \(logoURL.path)")
}

let ink = NSColor(srgbRed: 0.09, green: 0.10, blue: 0.13, alpha: 1)
let muted = NSColor(srgbRed: 0.37, green: 0.40, blue: 0.46, alpha: 1)
let surface = NSColor(srgbRed: 0.96, green: 0.97, blue: 0.98, alpha: 1)
let line = NSColor(srgbRed: 0.84, green: 0.86, blue: 0.89, alpha: 1)
let brand = NSColor(srgbRed: 0.31, green: 0.56, blue: 0.94, alpha: 1)

func drawText(
    _ value: String,
    at point: NSPoint,
    font: NSFont,
    color: NSColor,
    alignment: NSTextAlignment = .left,
    width: CGFloat? = nil
) {
    let style = NSMutableParagraphStyle()
    style.alignment = alignment
    let attributes: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: color,
        .paragraphStyle: style,
    ]
    let size = width.map { NSSize(width: $0, height: 40) }
        ?? (value as NSString).size(withAttributes: attributes)
    (value as NSString).draw(in: NSRect(origin: point, size: size), withAttributes: attributes)
}

func render(size: NSSize, drawing: () -> Void) -> NSBitmapImageRep {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(size.width),
        pixelsHigh: Int(size.height),
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bitmapFormat: [],
        bytesPerRow: 0,
        bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Unable to create \(Int(size.width))x\(Int(size.height)) canvas")
    }

    bitmap.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    drawing()
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return bitmap
}

func write(_ bitmap: NSBitmapImageRep, to relativePath: String, type: NSBitmapImageRep.FileType) {
    guard let data = bitmap.representation(using: type, properties: [:]) else {
        fatalError("Unable to encode \(relativePath)")
    }

    let outputURL = root.appendingPathComponent(relativePath)
    try! FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try! data.write(to: outputURL)
    print("Generated \(relativePath)")
}

let header = render(size: NSSize(width: 150, height: 57)) {
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: 150, height: 57).fill()
    surface.setFill()
    NSRect(x: 0, y: 0, width: 150, height: 1).fill()
    logo.draw(in: NSRect(x: 101, y: 7, width: 43, height: 43))
}
write(header, to: "src-tauri/install/windows/header.bmp", type: .bmp)

let sidebar = render(size: NSSize(width: 164, height: 314)) {
    surface.setFill()
    NSRect(x: 0, y: 0, width: 164, height: 314).fill()

    NSColor.white.setFill()
    NSBezierPath(
        roundedRect: NSRect(x: 18, y: 116, width: 128, height: 128),
        xRadius: 8,
        yRadius: 8
    ).fill()
    logo.draw(in: NSRect(x: 26, y: 124, width: 112, height: 112))

    drawText(
        "ORBIT BROWSER",
        at: NSPoint(x: 12, y: 78),
        font: .systemFont(ofSize: 13, weight: .semibold),
        color: ink,
        alignment: .center,
        width: 140
    )
    drawText(
        "Local browser runtime",
        at: NSPoint(x: 12, y: 57),
        font: .systemFont(ofSize: 9, weight: .regular),
        color: muted,
        alignment: .center,
        width: 140
    )

    brand.setFill()
    NSBezierPath(
        roundedRect: NSRect(x: 62, y: 32, width: 40, height: 3),
        xRadius: 1.5,
        yRadius: 1.5
    ).fill()
}
write(sidebar, to: "src-tauri/install/windows/sidebar.bmp", type: .bmp)

let dmg = render(size: NSSize(width: 660, height: 400)) {
    surface.setFill()
    NSRect(x: 0, y: 0, width: 660, height: 400).fill()

    NSColor.white.setFill()
    NSBezierPath(
        roundedRect: NSRect(x: 36, y: 32, width: 588, height: 336),
        xRadius: 12,
        yRadius: 12
    ).fill()

    logo.draw(in: NSRect(x: 247, y: 298, width: 40, height: 40))
    drawText(
        "Orbit Browser",
        at: NSPoint(x: 295, y: 309),
        font: .systemFont(ofSize: 19, weight: .semibold),
        color: ink
    )
    drawText(
        "Drag Orbit Browser to Applications",
        at: NSPoint(x: 80, y: 245),
        font: .systemFont(ofSize: 13, weight: .regular),
        color: muted,
        alignment: .center,
        width: 500
    )

    let arrow = NSBezierPath()
    arrow.lineWidth = 3
    arrow.lineCapStyle = .round
    arrow.move(to: NSPoint(x: 256, y: 180))
    arrow.line(to: NSPoint(x: 404, y: 180))
    brand.setStroke()
    arrow.stroke()

    let arrowHead = NSBezierPath()
    arrowHead.move(to: NSPoint(x: 404, y: 180))
    arrowHead.line(to: NSPoint(x: 392, y: 190))
    arrowHead.move(to: NSPoint(x: 404, y: 180))
    arrowHead.line(to: NSPoint(x: 392, y: 170))
    arrowHead.lineWidth = 3
    arrowHead.lineCapStyle = .round
    brand.setStroke()
    arrowHead.stroke()

    line.setStroke()
    let divider = NSBezierPath()
    divider.move(to: NSPoint(x: 80, y: 91))
    divider.line(to: NSPoint(x: 580, y: 91))
    divider.lineWidth = 1
    divider.stroke()

    drawText(
        "Upgrades preserve your local environments, tasks, and profiles.",
        at: NSPoint(x: 80, y: 78),
        font: .systemFont(ofSize: 10, weight: .regular),
        color: muted,
        alignment: .center,
        width: 500
    )
}
write(dmg, to: "src-tauri/install/macos/dmg-background.png", type: .png)
