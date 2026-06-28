import os
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Register a Cyrillic-compliant font
FONT_NAME = "Helvetica" # Default fallback
CYRILLIC_FONT_PATH = None

# Search for available TTF fonts containing Cyrillic
potential_paths = [
    # Windows paths
    "C:\\Windows\\Fonts\\Arial.ttf",
    "C:\\Windows\\Fonts\\calibri.ttf",
    # Linux paths (Docker standard locations)
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Arial.ttf",
    # Local fallback
    "./DejaVuSans.ttf"
]

for path in potential_paths:
    if os.path.exists(path):
        CYRILLIC_FONT_PATH = path
        break

if CYRILLIC_FONT_PATH:
    try:
        pdfmetrics.registerFont(TTFont("CyrillicFont", CYRILLIC_FONT_PATH))
        pdfmetrics.registerFont(TTFont("CyrillicFont-Bold", CYRILLIC_FONT_PATH.replace("Regular", "Bold").replace("Regular", "Bold") if "Regular" in CYRILLIC_FONT_PATH else CYRILLIC_FONT_PATH))
        FONT_NAME = "CyrillicFont"
        print(f"Successfully registered Cyrillic font from: {CYRILLIC_FONT_PATH}")
    except Exception as e:
        print(f"Failed to register font {CYRILLIC_FONT_PATH}: {e}. Falling back to default PDF fonts.")
else:
    print("Warning: No Cyrillic TTF font found. Russian characters might not render correctly in PDF.")

def generate_pdf_report(filename: str, grid_state_data: list, edge_data: list):
    """
    Generates a professional PDF report containing grid status,
    risk levels, and meteorological observations.
    """
    doc = SimpleDocTemplate(filename, pagesize=letter, rightMargin=36, leftMargin=36, topMargin=36, bottomMargin=36)
    story = []
    
    # Setup styles
    styles = getSampleStyleSheet()
    
    # Custom styles supporting registered font
    title_style = ParagraphStyle(
        'ReportTitle',
        parent=styles['Heading1'],
        fontName=FONT_NAME if FONT_NAME != "Helvetica" else "Helvetica-Bold",
        fontSize=20,
        leading=24,
        textColor=colors.HexColor("#1A365D"),
        spaceAfter=15
    )
    
    subtitle_style = ParagraphStyle(
        'ReportSubtitle',
        parent=styles['Normal'],
        fontName=FONT_NAME,
        fontSize=10,
        leading=14,
        textColor=colors.HexColor("#4A5568"),
        spaceAfter=20
    )
    
    heading_style = ParagraphStyle(
        'SectionHeading',
        parent=styles['Heading2'],
        fontName=FONT_NAME if FONT_NAME != "Helvetica" else "Helvetica-Bold",
        fontSize=14,
        leading=18,
        textColor=colors.HexColor("#2C5282"),
        spaceBefore=15,
        spaceAfter=10
    )
    
    body_style = ParagraphStyle(
        'TableBody',
        parent=styles['Normal'],
        fontName=FONT_NAME,
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#2D3748")
    )
    
    body_bold_style = ParagraphStyle(
        'TableBodyBold',
        parent=styles['Normal'],
        fontName=FONT_NAME if FONT_NAME != "Helvetica" else "Helvetica-Bold",
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#1A202C")
    )

    # Document Header
    story.append(Paragraph("СИСТЕМА МОНИТОРИНГА И ПРЕДСКАЗАНИЯ АВАРИЙНЫХ СИТУАЦИЙ", title_style))
    story.append(Paragraph(f"<b>Отчет о состоянии электросети</b> | Сгенерировано: {grid_state_data[0]['latest_prediction'].timestamp.strftime('%Y-%m-%d %H:%M:%S') if grid_state_data and grid_state_data[0]['latest_prediction'] else 'Вручную'}", subtitle_style))
    story.append(Spacer(1, 10))

    # Summary Statistics
    total_nodes = len(grid_state_data)
    red_nodes = sum(1 for n in grid_state_data if n["latest_prediction"] and n["latest_prediction"].threat_level == "red")
    yellow_nodes = sum(1 for n in grid_state_data if n["latest_prediction"] and n["latest_prediction"].threat_level == "yellow")
    green_nodes = total_nodes - red_nodes - yellow_nodes

    summary_text = f"<b>Сводная статистика сети:</b> Всего энергообъектов: <b>{total_nodes}</b> | " \
                   f"Критический риск (<font color='red'>Красный</font>): <b>{red_nodes}</b> | " \
                   f"Повышенный риск (<font color='orange'>Желтый</font>): <b>{yellow_nodes}</b> | " \
                   f"Норма (<font color='green'>Зеленый</font>): <b>{green_nodes}</b>"
    story.append(Paragraph(summary_text, body_style))
    story.append(Spacer(1, 15))

    # Critical Alerts Section
    if red_nodes > 0:
        story.append(Paragraph("КРИТИЧЕСКИЕ ПРЕДУПРЕЖДЕНИЯ (КРАСНЫЙ УРОВЕНЬ УГРОЗЫ)", heading_style))
        alert_data = [["Имя объекта", "Тип", "Износ %", "Ветер", "Сейсмика", "Вероятность"]]
        for n in grid_state_data:
            pred = n["latest_prediction"]
            meteo = n["latest_meteo"]
            if pred and pred.threat_level == "red":
                node_type_ru = "Генерация" if n['node'].type == "generation" else "Подстанция" if n['node'].type == "substation" else "ЛЭП узел"
                alert_data.append([
                    n['node'].name,
                    node_type_ru,
                    f"{n['node'].wear}%",
                    f"{meteo.wind_speed} м/с" if meteo else "-",
                    f"{meteo.actual_seismicity} б" if meteo else "-",
                    f"{round(pred.cascade_probability * 100, 1)}%"
                ])
        
        alert_table = Table(alert_data, colWidths=[130, 80, 60, 60, 60, 90])
        alert_table.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor("#FFF5F5")),
            ('TEXTCOLOR', (0,0), (-1,0), colors.HexColor("#C53030")),
            ('FONTNAME', (0,0), (-1,-1), FONT_NAME),
            ('BOTTOMPADDING', (0,0), (-1,0), 6),
            ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor("#FED7D7")),
            ('ALIGN', (0,0), (-1,-1), 'CENTER'),
            ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ]))
        story.append(alert_table)
        story.append(Spacer(1, 15))

    # Main Grid State Table
    story.append(Paragraph("ДЕТАЛЬНОЕ СОСТОЯНИЕ ОБЪЕКТОВ СЕТИ", heading_style))
    table_data = [["ID", "Название", "Тип", "Погода", "Индекс гололеда", "Индекс опасности", "Риск", "Угроза"]]
    
    for n in grid_state_data:
        pred = n["latest_prediction"]
        meteo = n["latest_meteo"]
        indices = n["calculated_indices"]
        
        node_type_ru = "Генерация" if n['node'].type == "generation" else "Подстанция" if n['node'].type == "substation" else "ЛЭП узел"
        weather_str = f"T: {meteo.temperature}°C, W: {meteo.wind_speed}м/с" if meteo else "Нет данных"
        
        prob_str = f"{round(pred.cascade_probability * 100, 1)}%" if pred else "-"
        
        threat_level_ru = "-"
        threat_color = colors.HexColor("#2D3748")
        if pred:
            if pred.threat_level == "green":
                threat_level_ru = "Норма"
                threat_color = colors.HexColor("#38A169")
            elif pred.threat_level == "yellow":
                threat_level_ru = "Внимание"
                threat_color = colors.HexColor("#DD6B20")
            elif pred.threat_level == "red":
                threat_level_ru = "Критический"
                threat_color = colors.HexColor("#E53E3E")

        table_data.append([
            str(n['node'].id),
            n['node'].name,
            node_type_ru,
            weather_str,
            str(indices.get("ice_index", 0.0)),
            str(indices.get("complex_danger", 0.0)),
            prob_str,
            Paragraph(f"<font color='{threat_color.hexval()}'><b>{threat_level_ru}</b></font>", body_bold_style)
        ])

    grid_table = Table(table_data, colWidths=[30, 110, 70, 120, 60, 60, 45, 55])
    grid_table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor("#EDF2F7")),
        ('TEXTCOLOR', (0,0), (-1,0), colors.HexColor("#2D3748")),
        ('FONTNAME', (0,0), (-1,-1), FONT_NAME),
        ('FONTSIZE', (0,0), (-1,-1), 8),
        ('BOTTOMPADDING', (0,0), (-1,0), 6),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor("#CBD5E0")),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ]))
    story.append(grid_table)
    
    # Build Document
    doc.build(story)
